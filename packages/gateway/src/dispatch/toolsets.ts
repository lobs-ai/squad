import type { Dispatcher } from "./index.js";
import {
  ToolsetRegistry,
  ToolsetUnknownError,
  ToolsetMissingToolError,
} from "../toolsets/registry.js";
import { ProtocolError, ErrorCode } from "@squad/protocol";

export function registerToolsetMethods(
  dispatcher: Dispatcher,
  toolsets: ToolsetRegistry,
): void {
  dispatcher.register("toolsets.list", async () => ({
    toolsets: toolsets.list(),
  }));

  dispatcher.register("toolsets.resolve", async (params) => {
    try {
      const tools = toolsets.resolve(params.name);
      return { name: params.name, tools };
    } catch (err) {
      if (err instanceof ToolsetUnknownError) {
        throw new ProtocolError(ErrorCode.not_found, err.message);
      }
      if (err instanceof ToolsetMissingToolError) {
        throw new ProtocolError(ErrorCode.invalid_params, err.message);
      }
      throw err;
    }
  });
}
