import { definePlugin } from "@squad/plugin-sdk";
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

    api.logger.info("google-drive plugin ready");
  },
});
