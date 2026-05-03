import type { ToolGroup } from "../groups.js";
import { PLUGIN_MANAGEMENT_GUIDANCE } from "./prompt.js";

export type {
  PluginManagementBackend,
  PluginCatalogEntrySummary,
  PluginConfigFieldSummary,
  PluginDescribeResult,
  PluginInstallSuccess,
  PluginInstallFailure,
  PluginInstallResult,
  PluginUninstallResult,
  PluginSetupChatResult,
} from "./backend.js";
export {
  PluginListTool,
  PluginDescribeTool,
  PluginInstallTool,
  PluginUninstallTool,
  PluginStartSetupChatTool,
  registerPluginManagementTools,
} from "./tools.js";
export { PLUGIN_MANAGEMENT_GUIDANCE } from "./prompt.js";

/**
 * Default tool group — every session can install/uninstall/configure
 * plugins. Plugin management isn't lazy because the user is just as likely
 * to ask in a normal session ("hey set up Discord for me") as in a
 * dedicated setup chat.
 */
export const pluginManagementGroup: ToolGroup = {
  name: "plugin-management",
  description: "Install, configure, and remove first-party plugins on this gateway",
  toolNames: [
    "plugin_list",
    "plugin_describe",
    "plugin_install",
    "plugin_uninstall",
    "plugin_start_setup_chat",
  ],
  guidance: PLUGIN_MANAGEMENT_GUIDANCE,
  default: true,
};
