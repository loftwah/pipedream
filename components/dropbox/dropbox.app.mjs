import dropbox from "dropbox";
import fetch from "isomorphic-fetch";
import config from "./config.mjs";
import isString from "lodash/isString.js";

const Dropbox = dropbox.Dropbox;

export default {
  type: "app",
  app: "dropbox",
  propDefinitions: {
    pathFolder: {
      type: "string",
      label: "Path",
      description: "The folder path. (Please use a valid path to filter the values)",
      optional: false,
      useQuery: true,
      async options({ query }) {
        return this.getPathOptions(query, {
          omitFiles: true,
        });
      },
    },
    pathFile: {
      type: "string",
      label: "Path",
      description: "The file path. (Please use a valid path to filter the values)",
      optional: false,
      useQuery: true,
      async options({ query }) {
        return this.getPathOptions(query, {
          omitFolders: true,
        });
      },
    },
    pathFileFolder: {
      type: "string",
      label: "Path",
      description: "The file or folder path. (Please use a valid path to filter the values)",
      optional: false,
      useQuery: true,
      async options({ query }) {
        return this.getPathOptions(query);
      },
    },
    recursive: {
      type: "boolean",
      label: "Recursive",
      description: "Also watch sub-directories and their contents.",
      optional: false,
      default: false,
    },
    query: {
      type: "string",
      label: "Query",
      description: "The string to search for. May match across multiple fields based on the request arguments.",
    },
    limit: {
      type: "integer",
      label: "Limit",
      description: "Specify a max amount of register to be fetched.",
      optional: true,
      min: 1,
    },
  },
  methods: {
    async sdk() {
      const baseClientOpts = {
        accessToken: this.$auth.oauth_access_token,
        fetch,
      };

      // In order to properly set the [root
      // path](https://www.dropbox.com/developers/reference/path-root-header-modes)
      // to use in every API request we first need to extract some information
      // from the authenticated user's account, for which we need to create a
      // client and issue an API request.
      const dpx = new Dropbox(baseClientOpts);
      const { result } = await dpx.usersGetCurrentAccount();

      const pathRoot = JSON.stringify({
        ".tag": "root",
        "root": result.root_info.root_namespace_id,
      });
      return new Dropbox({
        ...baseClientOpts,
        pathRoot,
      });
    },
    normalizeError(err) {
      if (!err) {
        throw new Error("Unknown error");
      }

      if (isString(err.error)) {
        throw new Error(err.error);
      }

      if (err.error?.error_summary) {
        throw new Error(err.error.error_summary);
      }

      throw new Error(JSON.stringify(err));
    },
    async getPathOptions(path, opts = {}) {
      const {
        omitFolders,
        omitFiles,
      } = opts;

      const LIMIT = 100;

      let data = [];
      let cursor = null;
      path = path === "/" || path === null
        ? ""
        : path;
      const dpx = await this.sdk();

      let res = await dpx.filesListFolder({
        path,
        limit: LIMIT,
        recursive: true,
      });

      if (!res.result.has_more) {
        data = res.result.entries.map((folder) => ({
          label: folder.path_display,
          value: {
            value: folder.path_lower,
            type: folder[".tag"],
          },
        }));
      } else {
        data = res.result.entries.map((folder) => ({
          label: folder.path_display,
          value: {
            value: folder.path_lower,
            type: folder[".tag"],
          },
        }));
        cursor = res.result.cursor;
        do {
          const res = await dpx.filesListFolderContinue({
            cursor,
          });
          data = data.concat(res.result?.entries.map((folder) => ({
            label: folder.path_display,
            value: {
              value: folder.path_lower,
              type: folder[".tag"],
            },
          })));
          cursor = res.result.cursor;
          if (!res.result.has_more) {
            break;
          }
        } while (true);
      }

      if (omitFiles) {
        data = data.filter((item) => item.value.type !== "file");
      }

      if (omitFolders) {
        data = data.filter((item) => item.value.type !== "folder");
      }

      // eslint-disable-next-line multiline-ternary
      return data.sort((a, b) => a.label < b.label ? 1 : -1);
    },
    async initState(context) {
      const {
        path,
        recursive,
        db,
      } = context;
      try {
        const fixedPath = path == "/"
          ? ""
          : path;
        const dpx = await this.sdk();
        let response = await dpx.filesListFolderGetLatestCursor({
          path: fixedPath,
          recursive,
        });
        if (response.result) {
          response = response.result;
        }
        const { cursor } = response;
        const state = {
          path,
          recursive,
          cursor,
        };
        db.set("dropbox_state", state);
        return state;
      } catch (err) {
        console.log(err);
        throw `Error connecting to Dropbox API to get latest cursor for folder: ${path}${
          recursive
            ? " (recursive)"
            : ""
        }`;
      }
    },
    async getState(context) {
      const {
        path,
        recursive,
        db,
      } = context;
      let state = db.get("dropbox_state");
      if (state == null || state.path != path || state.recursive != recursive) {
        state = await this.initState(context);
      }
      return state;
    },
    async createFolder(args) {
      try {
        const dpx = await this.sdk();
        return await dpx.filesCreateFolderV2(args);
      } catch (err) {
        this.normalizeError(err);
      }
    },
    async listFileRevisions(args) {
      try {
        const dpx = await this.sdk();
        return await dpx.filesListRevisions(args);
      } catch (err) {
        this.normalizeError(err);
      }
    },
    async filesMove(args) {
      try {
        const dpx = await this.sdk();
        return await dpx.filesMoveV2(args);
      } catch (err) {
        this.normalizeError(err);
      }
    },
    async searchFilesFolders(params, limit) {
      try {
        const dpx = await this.sdk();
        let data = [];
        let cursor = null;

        const args = {
          ...params,
          options: {
            ...params.options,
            max_results: limit <= config.SEARCH_FILE_FOLDERS.DEFAULT_MAX_RESULTS
              ? limit
              : config.SEARCH_FILE_FOLDERS.DEFAULT_MAX_RESULTS,
          },
        };
        let res = await dpx.filesSearchV2(args);

        if (!res.result?.has_more || limit <= config.SEARCH_FILE_FOLDERS.DEFAULT_MAX_RESULTS) {
          return res.result?.matches;
        }

        data = res.result?.matches;
        cursor = res.result?.cursor;
        do {
          const res = await dpx.filesSearchContinueV2({
            cursor,
          });
          data = data.concat(res.result?.matches);
          cursor = res.result?.cursor;
          if (!res.result?.has_more || data.length >= limit) {
            break;
          }
        } while (true);
        return data;
      } catch (err) {
        this.normalizeError(err);
      }
    },
  },
};