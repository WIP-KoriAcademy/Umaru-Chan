import { Member, Message, User } from "eris";
import moment from "moment-timezone";
import escapeStringRegexp from "escape-string-regexp";
import safeRegex from "safe-regex";
import { isFullMessage, MINUTES, multiSorter, noop, sorter, trimLines } from "../../../utils";
import { sendErrorMessage } from "../../../pluginUtils";
import { PluginData } from "knub";
import { ArgsFromSignatureOrArray } from "knub/dist/commands/commandUtils";
import { searchCmdSignature } from "./SearchCmd";
import { banSearchSignature } from "./BanSearchCmd";
import { UtilityPluginType } from "../types";
import { refreshMembersIfNeeded } from "../refreshMembers";

const SEARCH_RESULTS_PER_PAGE = 15;
const SEARCH_ID_RESULTS_PER_PAGE = 50;
const SEARCH_EXPORT_LIMIT = 1_000_000;

export enum SearchType {
  MemberSearch,
  BanSearch,
}

class SearchError extends Error {}

type MemberSearchParams = ArgsFromSignatureOrArray<typeof searchCmdSignature>;
type BanSearchParams = ArgsFromSignatureOrArray<typeof banSearchSignature>;

export async function displaySearch(
  pluginData: PluginData<UtilityPluginType>,
  args: MemberSearchParams,
  searchType: SearchType.MemberSearch,
  msg: Message,
);
export async function displaySearch(
  pluginData: PluginData<UtilityPluginType>,
  args: BanSearchParams,
  searchType: SearchType.BanSearch,
  msg: Message,
);
export async function displaySearch(
  pluginData: PluginData<UtilityPluginType>,
  args: MemberSearchParams | BanSearchParams,
  searchType: SearchType,
  msg: Message,
) {
  // If we're not exporting, load 1 page of search results at a time and allow the user to switch pages with reactions
  let originalSearchMsg: Message = null;
  let searching = false;
  let currentPage = args.page || 1;
  let hasReactions = false;
  let clearReactionsFn = null;
  let clearReactionsTimeout = null;

  const perPage = args.ids ? SEARCH_ID_RESULTS_PER_PAGE : SEARCH_RESULTS_PER_PAGE;

  const loadSearchPage = async page => {
    if (searching) return;
    searching = true;

    // The initial message is created here, as well as edited to say "Searching..." on subsequent requests
    // We don't "await" this so we can start loading the search results immediately instead of after the message has been created/edited
    let searchMsgPromise: Promise<Message>;
    if (originalSearchMsg) {
      searchMsgPromise = originalSearchMsg.edit("Searching...");
    } else {
      searchMsgPromise = msg.channel.createMessage("Searching...");
      searchMsgPromise.then(m => (originalSearchMsg = m));
    }

    let searchResult;
    try {
      switch (searchType) {
        case SearchType.MemberSearch:
          searchResult = await performMemberSearch(pluginData, args as MemberSearchParams, page, perPage);
          break;
        case SearchType.BanSearch:
          searchResult = await performBanSearch(pluginData, args as BanSearchParams, page, perPage);
          break;
      }
    } catch (e) {
      if (e instanceof SearchError) {
        return sendErrorMessage(pluginData, msg.channel, e.message);
      }

      throw e;
    }

    if (searchResult.totalResults === 0) {
      return sendErrorMessage(pluginData, msg.channel, "No results found");
    }

    const resultWord = searchResult.totalResults === 1 ? "matching member" : "matching members";
    const headerText =
      searchResult.totalResults > perPage
        ? trimLines(`
            **Page ${searchResult.page}** (${searchResult.from}-${searchResult.to}) (total ${searchResult.totalResults})
          `)
        : `Found ${searchResult.totalResults} ${resultWord}`;

    const resultList = args.ids
      ? formatSearchResultIdList(searchResult.results)
      : formatSearchResultList(searchResult.results);

    const result = trimLines(`
        ${headerText}
        \`\`\`js
        ${resultList}
        \`\`\`
      `);

    const searchMsg = await searchMsgPromise;
    searchMsg.edit(result);

    // Set up pagination reactions if needed. The reactions are cleared after a timeout.
    if (searchResult.totalResults > perPage) {
      if (!hasReactions) {
        hasReactions = true;
        searchMsg.addReaction("⬅");
        searchMsg.addReaction("➡");
        searchMsg.addReaction("🔄");

        const listenerFn = pluginData.events.on("messageReactionAdd", ({ args: { message: rMsg, emoji, userID } }) => {
          if (rMsg.id !== searchMsg.id) return;
          if (userID !== msg.author.id) return;
          if (!["⬅", "➡", "🔄"].includes(emoji.name)) return;

          if (emoji.name === "⬅" && currentPage > 1) {
            loadSearchPage(currentPage - 1);
          } else if (emoji.name === "➡" && currentPage < searchResult.lastPage) {
            loadSearchPage(currentPage + 1);
          } else if (emoji.name === "🔄") {
            loadSearchPage(currentPage);
          }

          if (isFullMessage(rMsg)) {
            rMsg.removeReaction(emoji.name, userID);
          }
        });

        clearReactionsFn = async () => {
          searchMsg.removeReactions().catch(noop);
          pluginData.events.off("messageReactionAdd", listenerFn);
        };
      }

      clearTimeout(clearReactionsTimeout);
      clearReactionsTimeout = setTimeout(clearReactionsFn, 5 * MINUTES);
    }

    currentPage = searchResult.page;
    searching = false;
  };

  loadSearchPage(currentPage);
}

export async function archiveSearch(
  pluginData: PluginData<UtilityPluginType>,
  args: MemberSearchParams,
  searchType: SearchType.MemberSearch,
  msg: Message,
);
export async function archiveSearch(
  pluginData: PluginData<UtilityPluginType>,
  args: BanSearchParams,
  searchType: SearchType.BanSearch,
  msg: Message,
);
export async function archiveSearch(
  pluginData: PluginData<UtilityPluginType>,
  args: MemberSearchParams | BanSearchParams,
  searchType: SearchType,
  msg: Message,
) {
  let results;
  try {
    switch (searchType) {
      case SearchType.MemberSearch:
        results = await performMemberSearch(pluginData, args as MemberSearchParams, 1, SEARCH_EXPORT_LIMIT);
        break;
      case SearchType.BanSearch:
        results = await performBanSearch(pluginData, args as BanSearchParams, 1, SEARCH_EXPORT_LIMIT);
        break;
    }
  } catch (e) {
    if (e instanceof SearchError) {
      return sendErrorMessage(pluginData, msg.channel, e.message);
    }

    throw e;
  }

  if (results.totalResults === 0) {
    return sendErrorMessage(pluginData, msg.channel, "No results found");
  }

  const resultList = args.ids ? formatSearchResultIdList(results.results) : formatSearchResultList(results.results);

  const archiveId = await pluginData.state.archives.create(
    trimLines(`
      Search results (total ${results.totalResults}):

      ${resultList}
    `),
    moment().add(1, "hour"),
  );

  const baseUrl = (pluginData.getKnubInstance().getGlobalConfig() as any).url; // FIXME: No any cast
  const url = await pluginData.state.archives.getUrl(baseUrl, archiveId);

  msg.channel.createMessage(`Exported search results: ${url}`);

  return;
}

async function performMemberSearch(
  pluginData: PluginData<UtilityPluginType>,
  args: MemberSearchParams,
  page = 1,
  perPage = SEARCH_RESULTS_PER_PAGE,
): Promise<{ results: Member[]; totalResults: number; page: number; lastPage: number; from: number; to: number }> {
  refreshMembersIfNeeded(pluginData.guild);

  let matchingMembers = Array.from(pluginData.guild.members.values());

  if (args.role) {
    const roleIds = args.role.split(",");
    matchingMembers = matchingMembers.filter(member => {
      for (const role of roleIds) {
        if (!member.roles.includes(role)) return false;
      }

      return true;
    });
  }

  if (args.voice) {
    matchingMembers = matchingMembers.filter(m => m.voiceState.channelID != null);
  }

  if (args.bot) {
    matchingMembers = matchingMembers.filter(m => m.bot);
  }

  if (args.query) {
    let queryRegex: RegExp;
    if (args.regex) {
      queryRegex = new RegExp(args.query.trimStart(), args["case-sensitive"] ? "" : "i");
    } else {
      queryRegex = new RegExp(escapeStringRegexp(args.query.trimStart()), args["case-sensitive"] ? "" : "i");
    }

    if (!safeRegex(queryRegex)) {
      throw new SearchError("Unsafe/too complex regex (star depth is limited to 1)");
    }

    if (args["status-search"]) {
      matchingMembers = matchingMembers.filter(member => {
        if (member.game) {
          if (member.game.name && member.game.name.match(queryRegex)) {
            return true;
          }

          if (member.game.state && member.game.state.match(queryRegex)) {
            return true;
          }

          if (member.game.details && member.game.details.match(queryRegex)) {
            return true;
          }

          if (member.game.assets) {
            if (member.game.assets.small_text && member.game.assets.small_text.match(queryRegex)) {
              return true;
            }

            if (member.game.assets.large_text && member.game.assets.large_text.match(queryRegex)) {
              return true;
            }
          }

          if (member.game.emoji && member.game.emoji.name.match(queryRegex)) {
            return true;
          }
        }
        return false;
      });
    } else {
      matchingMembers = matchingMembers.filter(member => {
        if (member.nick && member.nick.match(queryRegex)) return true;

        const fullUsername = `${member.user.username}#${member.user.discriminator}`;
        if (fullUsername.match(queryRegex)) return true;

        return false;
      });
    }
  }

  const [, sortDir, sortBy] = args.sort ? args.sort.match(/^(-?)(.*)$/) : [null, "ASC", "name"];
  const realSortDir = sortDir === "-" ? "DESC" : "ASC";

  if (sortBy === "id") {
    matchingMembers.sort(sorter(m => BigInt(m.id), realSortDir));
  } else {
    matchingMembers.sort(
      multiSorter([
        [m => m.username.toLowerCase(), realSortDir],
        [m => m.discriminator, realSortDir],
      ]),
    );
  }

  const lastPage = Math.max(1, Math.ceil(matchingMembers.length / perPage));
  page = Math.min(lastPage, Math.max(1, page));

  const from = (page - 1) * perPage;
  const to = Math.min(from + perPage, matchingMembers.length);

  const pageMembers = matchingMembers.slice(from, to);

  return {
    results: pageMembers,
    totalResults: matchingMembers.length,
    page,
    lastPage,
    from: from + 1,
    to,
  };
}

async function performBanSearch(
  pluginData: PluginData<UtilityPluginType>,
  args: BanSearchParams,
  page = 1,
  perPage = SEARCH_RESULTS_PER_PAGE,
): Promise<{ results: User[]; totalResults: number; page: number; lastPage: number; from: number; to: number }> {
  let matchingBans = (await pluginData.guild.getBans()).map(x => x.user);

  if (args.query) {
    let queryRegex: RegExp;
    if (args.regex) {
      queryRegex = new RegExp(args.query.trimStart(), args["case-sensitive"] ? "" : "i");
    } else {
      queryRegex = new RegExp(escapeStringRegexp(args.query.trimStart()), args["case-sensitive"] ? "" : "i");
    }

    if (!safeRegex(queryRegex)) {
      throw new SearchError("Unsafe/too complex regex (star depth is limited to 1)");
    }

    matchingBans = matchingBans.filter(user => {
      const fullUsername = `${user.username}#${user.discriminator}`;
      if (fullUsername.match(queryRegex)) return true;
    });
  }

  const [, sortDir, sortBy] = args.sort ? args.sort.match(/^(-?)(.*)$/) : [null, "ASC", "name"];
  const realSortDir = sortDir === "-" ? "DESC" : "ASC";

  if (sortBy === "id") {
    matchingBans.sort(sorter(m => BigInt(m.id), realSortDir));
  } else {
    matchingBans.sort(
      multiSorter([
        [m => m.username.toLowerCase(), realSortDir],
        [m => m.discriminator, realSortDir],
      ]),
    );
  }

  const lastPage = Math.max(1, Math.ceil(matchingBans.length / perPage));
  page = Math.min(lastPage, Math.max(1, page));

  const from = (page - 1) * perPage;
  const to = Math.min(from + perPage, matchingBans.length);

  const pageMembers = matchingBans.slice(from, to);

  return {
    results: pageMembers,
    totalResults: matchingBans.length,
    page,
    lastPage,
    from: from + 1,
    to,
  };
}

function formatSearchResultList(members: Array<Member | User>): string {
  const longestId = members.reduce((longest, member) => Math.max(longest, member.id.length), 0);
  const lines = members.map(member => {
    const paddedId = member.id.padEnd(longestId, " ");
    let line;
    if (member instanceof Member) {
      line = `${paddedId} ${member.user.username}#${member.user.discriminator}`;
      if (member.nick) line += ` (${member.nick})`;
    } else {
      line = `${paddedId} ${member.username}#${member.discriminator}`;
    }
    return line;
  });
  return lines.join("\n");
}

function formatSearchResultIdList(members: Array<Member | User>): string {
  return members.map(m => m.id).join(" ");
}