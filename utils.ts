import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import chalk from "chalk";
import type { AIProviderConfig, Git } from "./types";

export const decapitalizeFirstLetter = (str: string) =>
  str.charAt(0).toLocaleLowerCase() + str.slice(1);

/**
 * Safely gets an error message from an unknown type.
 * @param error The error object, which can be of any type.
 * @returns A string representing the error message.
 */
export const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const pluralize = (
  count: number,
  singular: string,
  plural?: string,
): string => {
  if (count === 1) return singular;
  return plural || `${singular}s`;
};

/**
 * Wraps text to a specified maximum width.
 * @param text The text to wrap.
 * @param maxWidth The maximum width of each line (default: 80).
 * @returns The wrapped text as a single string with newlines.
 */
export const wrapText = (text: string, maxWidth: number = 80): string => {
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const spaceNeeded = currentLine.length > 0 ? 1 : 0;
    const wouldExceedWidth =
      currentLine.length + word.length + spaceNeeded > maxWidth;

    if (wouldExceedWidth) {
      if (currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        lines.push(word);
      }
    } else {
      currentLine += (currentLine.length > 0 ? " " : "") + word;
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines.join("\n");
};

/**
 * Returns a playful message based on the number of changes.
 * @param changesCount The number of changes.
 * @returns A categorized message string.
 */
export const categorizeChangesCount = (changesCount: number) => {
  if (changesCount < 10) return "Nice!";
  if (changesCount < 50) return chalk.bold("Damn, solid work!");
  if (changesCount < 100) return chalk.green("Holy... we cookin'!");
  return chalk.red("Yikes, you'd better buy your reviewers some coffee!");
};

/**
 * Provides a status category based on a token count.
 * Useful for giving user feedback on API usage, cost, and wait times.
 * @param tokenCount The number of tokens.
 * @returns An object with an emoji, label, and optional description and confirmation flag.
 */
export const categorizeTokenCount = (tokenCount: number) => {
  if (tokenCount < 5000) {
    return {
      emoji: "🟢",
      label: `looking fresh ${chalk.dim("(instant response)")}`,
    };
  } else if (tokenCount < 15000) {
    return {
      emoji: "🟡",
      label: `still vibing ${chalk.dim("(1-2 seconds)")}`,
    };
  } else if (tokenCount < 50000) {
    return {
      emoji: "🟠",
      label: `getting spicy ${chalk.dim("(3-5 seconds)")}`,
    };
  } else if (tokenCount < 100000) {
    return {
      emoji: "🔴",
      label: `woah there territory ${chalk.dim("(may hit rate limits)")}`,
      description: "This will take 10+ seconds and cost significantly more.",
      needsConfirmation: true,
    };
  } else {
    return {
      emoji: undefined,
      label: chalk.bold.red("an absolute unit 💀"),
      description: "This exceeds most API limits and will be very expensive.",
      needsConfirmation: true,
    };
  }
};

/**
 * Retrieves the base branch of the repository, trying 'main' first, then 'master'.
 * @param git A simple-git instance.
 * @returns The name of the base branch, or undefined if neither is found.
 */
export const getBaseBranch = async (git: Git): Promise<string | undefined> => {
  for (const branch of ["main", "master"]) {
    try {
      await git.revparse(["--verify", `origin/${branch}`]);
      return branch;
    } catch {
      // Branch doesn't exist, so we try the next one
    }
  }
};

/**
 * Detects available AI provider based on environment variables and configures the appropriate provider.
 * Prioritizes Anthropic, then OpenAI, then Google Gemini.
 * @param enableThinking Whether to use thinking models for deeper reasoning
 * @returns The AI provider configuration object.
 * @throws Error if no valid API key is found.
 */
export const detectAndConfigureAIProvider = (
  enableThinking: boolean = false,
): AIProviderConfig => {
  // Check for Anthropic API key
  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (anthropicKey) {
    const anthropic = createAnthropic({ apiKey: anthropicKey });
    return {
      provider: "anthropic",
      model: anthropic("claude-3-5-sonnet-20241022"),
      name: "Claude 3.5 Sonnet",
    };
  }

  // Check for OpenAI API key
  const openaiKey = process.env["OPENAI_API_KEY"];
  if (openaiKey) {
    const openai = createOpenAI({ apiKey: openaiKey });
    return {
      provider: "openai",
      // Use o1-mini for thinking, gpt-4o for regular
      model: openai(enableThinking ? "o1" : "gpt-4o"),
      name: enableThinking ? "o1" : "GPT-4o",
    };
  }

  // Check for Google Gemini API key (fallback)
  const googleKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  if (googleKey) {
    const google = createGoogleGenerativeAI({ apiKey: googleKey });
    return {
      provider: "google",
      // Use gemini-2.0-flash for thinking, gemini-2.5-flash for regular
      model: google(
        enableThinking ? "gemini-2.0-flash-001" : "gemini-2.5-flash",
      ),
      name: enableThinking ? "Gemini 2.0 Flash (thinking)" : "Gemini 2.5 Flash",
    };
  }

  throw new Error(
    "No AI provider API key found. Please set one of:\n" +
      "- ANTHROPIC_API_KEY for Claude\n" +
      "- OPENAI_API_KEY for GPT\n" +
      "- GOOGLE_GENERATIVE_AI_API_KEY for Gemini",
  );
};

/**
 * Extracts a Jira ticket ID from a branch name.
 * Looks for patterns like XX-YYYY where XX is 2+ uppercase letters and YYYY is 1+ digits.
 * @param branchName The branch name to extract Jira ID from.
 * @returns The extracted Jira ticket ID or undefined if none found.
 */
export const extractJiraTicketId = (branchName: string): string | undefined => {
  // Match patterns like ABC-123, PROJ-4567, etc.
  // Pattern: 2+ uppercase letters, hyphen, 1+ digits
  const jiraPattern = /([A-Z]{2,}-\d+)/;
  const match = branchName.match(jiraPattern);
  return match ? match[1] : undefined;
};

/**
 * Builds commit message and display message based on commit data and Jira integration.
 * @param commit The commit object with type, scope, description, breaking flag.
 * @param jiraTicketId Optional Jira ticket ID for integration.
 * @returns Object containing commitMessage and displayMessage.
 */
export const buildCommitMessages = (
  commit: {
    type: string;
    scope?: string;
    description: string;
    breaking: boolean;
  },
  jiraTicketId?: string,
): { commitMessage: string; displayMessage: string } => {
  const description = decapitalizeFirstLetter(commit.description);

  // Handle Jira integration format
  if (jiraTicketId) {
    const jiraType = `${commit.type}${commit.breaking ? "!" : ""}`;
    const jiraDescription = description.replace(/\s+/g, "-");
    const fullJiraMessage = `${jiraTicketId}-${jiraType}-${jiraDescription}`;

    return {
      commitMessage: fullJiraMessage,
      displayMessage: fullJiraMessage,
    };
  }

  // Standard conventional commit format
  let prefix = `${commit.type}${
    commit.scope?.length ? `(${commit.scope})` : ""
  }${commit.breaking ? "!" : ""}`;

  // The AI may redundantly include the prefix in the description, so we remove it.
  if (description.startsWith(prefix)) {
    prefix = "";
  }

  const displayMessage = `${
    prefix ? `${chalk.bold(`${prefix}: `)}` : ""
  }${description}`;
  const commitMessage = `${prefix ? `${prefix}: ` : ""}${description}`;

  return {
    commitMessage,
    displayMessage,
  };
};
