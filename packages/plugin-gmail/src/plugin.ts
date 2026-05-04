import { definePlugin, PROMPT_SLOTS } from "@squad/plugin-sdk";
import { getSharedGoogleAuth } from "@squad/plugin-google-auth";
import { gmailGroup, registerGmailTools } from "./tools.js";

export default definePlugin({
  id: "@squad/plugin-gmail",
  name: "Gmail",
  version: "0.0.1",
  kinds: ["tool"],
  register(api) {
    const service = getSharedGoogleAuth();

    api.toolGroups.register(gmailGroup);
    registerGmailTools(api.tools, service);

    api.toolsets.register({
      name: "@squad/toolset-gmail",
      description: "Gmail — search, read, send, label.",
      tools: [...gmailGroup.toolNames],
    });

    api.promptFragments.register({
      slot: PROMPT_SLOTS.WEB_FETCH_AUTH_WALLED_DOMAINS,
      content:
        "mail.google.com — use gmail_search / gmail_read instead; web_fetch returns the Google sign-in page.",
    });
    api.promptFragments.register({
      slot: PROMPT_SLOTS.SYSTEM_STARTUP_WARNINGS,
      content:
        "gmail: no connected Google account has the 'gmail' feature enabled — gmail_* tools will throw. " +
        "Connect or enable via google_connect_url / google_list_accounts first.",
      when: () => service.authedClientFor("gmail") === null,
    });

    api.logger.info("gmail plugin ready");
  },
});
