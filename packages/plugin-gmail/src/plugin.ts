import { definePlugin } from "@squad/plugin-sdk";
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

    api.logger.info("gmail plugin ready");
  },
});
