import { definePlugin, PROMPT_SLOTS } from "@squad/plugin-sdk";
import { getSharedGoogleAuth } from "@squad/plugin-google-auth";
import { googleDriveGroup, registerGoogleDriveTools } from "./tools.js";

export default definePlugin({
  id: "@squad/plugin-google-drive",
  name: "Google Drive",
  version: "0.0.1",
  kinds: ["tool"],
  register(api) {
    const service = getSharedGoogleAuth();

    api.toolGroups.register(googleDriveGroup);
    registerGoogleDriveTools(api.tools, service);

    api.toolsets.register({
      name: "@squad/toolset-google-drive",
      description: "Google Drive — search, list, read.",
      tools: [...googleDriveGroup.toolNames],
    });

    api.promptFragments.register({
      slot: PROMPT_SLOTS.WEB_FETCH_AUTH_WALLED_DOMAINS,
      content:
        "drive.google.com, docs.google.com, sheets.google.com, slides.google.com — " +
        "use google_drive_search / google_drive_read; web_fetch returns the Google sign-in page.",
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
      content:
        "google-drive: no connected Google account has the 'drive' feature enabled — " +
        "google_drive_* tools will throw. Connect or enable via google_connect_url / google_list_accounts first.",
      when: () => service.authedClientFor("drive") === null,
    });

    api.logger.info("google-drive plugin ready");
  },
});
