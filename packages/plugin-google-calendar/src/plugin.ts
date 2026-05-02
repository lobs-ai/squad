import { definePlugin } from "@squad/plugin-sdk";
import { getSharedGoogleAuth } from "@squad/plugin-google-auth";
import { googleCalendarGroup, registerGoogleCalendarTools } from "./tools.js";

export default definePlugin({
  id: "@squad/plugin-google-calendar",
  name: "Google Calendar",
  version: "0.0.1",
  kinds: ["tool"],
  register(api) {
    const service = getSharedGoogleAuth();

    // Lazy-loadable tool group: tools stay hidden in the system prompt index
    // until the agent unlocks the group via describe_tool_group.
    api.toolGroups.register(googleCalendarGroup);
    registerGoogleCalendarTools(api.tools, service);

    // Curated bundle so subagents can pull the calendar surface in one line.
    api.toolsets.register({
      name: "@squad/toolset-google-calendar",
      description: "Google Calendar — list/create/update/delete/rsvp.",
      tools: [...googleCalendarGroup.toolNames],
    });

    api.logger.info("google-calendar plugin ready");
  },
});
