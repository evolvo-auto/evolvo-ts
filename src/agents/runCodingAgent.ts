import { Codex, Thread, type ThreadItem } from "@openai/codex-sdk";
import {
  CODING_AGENT_THREAD_OPTIONS,
  buildCodingPrompt,
} from "./codingAgent.js";

const codex = new Codex();
let activeThread: Thread | null = null;
const MERGE_PR_COMMAND_PATTERN = /\bgh\s+pr\s+merge\b/i;

export type CodingAgentRunResult = {
  mergedPullRequest: boolean;
};

function getThread(): Thread {
  if (!activeThread) {
    activeThread = codex.startThread(CODING_AGENT_THREAD_OPTIONS);
  }

  return activeThread;
}

function isFileEditRequest(prompt: string): boolean {
  return /\b(create|add|write|update|edit|modify|delete|remove)\b/i.test(prompt) &&
    /\b(file|files|src\/|\.ts|\.tsx|\.js|\.jsx|\.json|\.md)\b/i.test(prompt);
}

function formatFileChanges(item: Extract<ThreadItem, { type: "file_change" }>): string {
  return item.changes.map((change) => `${change.kind} ${change.path}`).join(", ");
}

function logCompletedItem(item: ThreadItem): void {
  if (item.type === "file_change") {
    console.log(`[file_change] ${formatFileChanges(item)}\n`);
    return;
  }

  if (item.type === "command_execution") {
    const output = item.aggregated_output.trim();
    console.log(`[command completed] ${item.command} (exit ${item.exit_code ?? "unknown"})`);

    if (output) {
      console.log(`${output}\n`);
    } else {
      console.log("");
    }

    return;
  }

  if (item.type === "agent_message") {
    console.log(`[assistant]\n${item.text}\n`);
  }
}

function logStartedItem(item: ThreadItem): void {
  if (item.type === "command_execution") {
    console.log(`[command] ${item.command}`);
    return;
  }

  if (item.type === "mcp_tool_call") {
    console.log(`[tool] mcp - ${item.server}.${item.tool}`);
    return;
  }

  if (item.type === "web_search") {
    console.log(`[tool] web_search - query: ${item.query}`);
  }
}

export async function runCodingAgent(prompt: string): Promise<CodingAgentRunResult> {
  console.log("=== Run starting ===");
  console.log(`[user] ${prompt}\n`);

  const thread = getThread();
  const { events } = await thread.runStreamed(buildCodingPrompt(prompt));

  const startedItems = new Set<string>();
  const completedItems = new Set<string>();
  let fileChangeSeen = false;
  let mergedPullRequest = false;
  let finalResponse = "";

  for await (const event of events) {
    if (event.type === "item.started") {
      if (startedItems.has(event.item.id)) {
        continue;
      }

      startedItems.add(event.item.id);
      logStartedItem(event.item);
      continue;
    }

    if (event.type === "item.updated") {
      if (event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }
      continue;
    }

    if (event.type === "item.completed") {
      if (completedItems.has(event.item.id)) {
        continue;
      }

      completedItems.add(event.item.id);

      if (event.item.type === "file_change" && event.item.status === "completed") {
        fileChangeSeen = true;
      }

      if (event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }

      if (
        event.item.type === "command_execution" &&
        event.item.exit_code === 0 &&
        MERGE_PR_COMMAND_PATTERN.test(event.item.command)
      ) {
        mergedPullRequest = true;
      }

      logCompletedItem(event.item);
      continue;
    }

    if (event.type === "turn.failed") {
      throw new Error(event.error.message);
    }

    if (event.type === "error") {
      throw new Error(event.message);
    }
  }

  console.log("=== Run complete ===\n");
  console.log("Final answer:\n");
  console.log(finalResponse);

  if (fileChangeSeen) {
    console.log("\n[file_change] One or more repository edits were executed.");
    return { mergedPullRequest };
  }

  console.log("\n[file_change] No repository edits were detected.");

  if (isFileEditRequest(prompt)) {
    throw new Error("The Codex run did not make repository edits for a file-edit request.");
  }

  return { mergedPullRequest };
}
