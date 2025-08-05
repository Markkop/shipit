import { streamObject } from "ai";
import { CAC } from "cac";
import chalk from "chalk";
import { countTokens } from "gpt-tokenizer";
import { simpleGit } from "simple-git";
import {
  responseSchema,
  systemInstruction,
  userInstruction,
} from "./constants.ts";
import { version } from "./package.json" with { type: "json" };
import { handlePullRequest } from "./pr.ts";
import { createPrompts } from "./prompts.ts";
import { handlePush } from "./push.ts";
import {
  buildCommitMessages,
  categorizeChangesCount,
  categorizeTokenCount,
  detectAndConfigureAIProvider,
  extractJiraTicketId,
  getErrorMessage,
  pluralize,
  wrapText,
} from "./utils.ts";

const cli = new CAC("shipit");

cli
  .command(
    "[...files]",
    "Send changes to AI to categorize and generate commit messages",
  )
  .option("-s,--silent", "Only log fatal errors to the console")
  .option("-y,--yes", "Automatically accept all commits, same as --force")
  .option("-f,--force", "Automatically accept all commits, same as --yes")
  .option("-u,--unsafe", "Skip token count verification")
  .option("-p, --push", "Push the changes if any after processing all commits")
  .option("--pr", "Automatically create a pull request")
  .option("-j,--jira", "Enable Jira ticket ID integration from branch name")
  .option("-t,--thinking", "Enable thinking models for deeper reasoning")
  .option(
    "-h,--history",
    "Include last 100 commit messages as additional context",
  );

cli.help();
cli.version(version);

const { args, options } = cli.parse() as {
  args: string[];
  options: { [key: string]: boolean };
};

if (options["help"] || options["version"]) process.exit(0);

async function main() {
  const { log, note, outro, spinner, confirm } = createPrompts({
    silent: options["silent"],
    force: options["force"] || options["yes"],
  });

  let aiConfig;
  try {
    aiConfig = detectAndConfigureAIProvider(options["thinking"]);
  } catch (error) {
    log.error(getErrorMessage(error));
    process.exit(1);
  }

  if (!options["silent"] && !options["force"] && !options["yes"]) {
    note(
      chalk.italic("Because writing 'fix stuff' gets old real quick..."),
      chalk.bold("🧹 Git Your Sh*t Together"),
    );
    log.info(
      `Using ${chalk.bold(aiConfig.name)} for AI assistance${options["thinking"] ? chalk.cyan(" (thinking mode enabled)") : ""}`,
    );
  }

  const analysisSpinner = spinner();
  analysisSpinner.start("Let's see what mess you've made this time...");

  const git = simpleGit(process.cwd());

  try {
    if (!(await git.checkIsRepo())) {
      analysisSpinner.stop("❌ Well, this is awkward...");
      outro(
        "Not a git repo? What are you trying to commit here? Run `git init` first! 🤦",
      );
      process.exit(1);
    }
  } catch (error) {
    analysisSpinner.stop("❌ Error checking git repository");
    log.error(`Failed to check git repository: ${getErrorMessage(error)}`);
    process.exit(1);
  }

  // Handle Jira integration if enabled
  let jiraTicketId: string | undefined;
  if (options["jira"]) {
    try {
      const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"]);
      jiraTicketId = extractJiraTicketId(currentBranch);

      if (jiraTicketId) {
        if (!options["silent"] && !options["force"] && !options["yes"]) {
          log.info(`🎫 Found Jira ticket: ${chalk.bold(jiraTicketId)}`);
        }
      } else {
        log.warn(
          `⚠️  Jira integration enabled but no ticket ID found in branch '${currentBranch}'`,
        );
        log.info("Expected format: XX-YYYY (e.g., PROJ-123)");
      }
    } catch (error) {
      log.error(`Failed to get current branch: ${getErrorMessage(error)}`);
      // Don't exit for Jira errors, just continue without integration
    }
  }

  let status, diffSummary, diff;
  try {
    const gitStatus = await git.status(args);
    const { files: _files, isClean, ...statusRest } = gitStatus;
    status = statusRest;

    if (isClean()) {
      analysisSpinner.stop("Huh... squeaky clean. Nothing to see here.");
      outro("No changes? Time to get to work! 🙄");
      process.exit(0);
    }

    if (status.conflicted && status.conflicted.length > 0) {
      analysisSpinner.stop("⚠️ Merge conflicts detected");
      outro(
        `Holy sh*t! Fix your ${status.conflicted.length} ${pluralize(
          status.conflicted.length,
          "conflict",
        )} first: ${status.conflicted.join(", ")}`,
      );
      process.exit(1);
    }

    if (args.length > 0) {
      analysisSpinner.message("Sniffing out your specified paths...");

      if (status.staged && status.staged.length > 0) {
        analysisSpinner.stop("⚠️  Hold up! Mixed signals detected!");
        outro(`You've got staged files AND specified paths? That's not gonna work.

Pick a lane:
- Unstage your files: \`git reset\`
- Commit the staged stuff first: \`git commit\`
- Or YOLO it without paths to handle everything`);
        process.exit(1);
      }
    }

    diffSummary = await git.diffSummary(args);
    diff = await git.diff(args);
  } catch (error) {
    analysisSpinner.stop("❌ Error analyzing git changes");
    log.error(`Failed to analyze git changes: ${getErrorMessage(error)}`);
    process.exit(1);
  }

  analysisSpinner.stop(
    `${categorizeChangesCount(diffSummary.files.length)} You've touched ${chalk.bold(
      `${diffSummary.files.length} ${pluralize(
        diffSummary.files.length,
        "file",
      )}`,
    )}!`,
  );

  // Build commit history if requested
  let commitHistoryMessages: string[] | undefined;
  if (options["history"]) {
    try {
      const logResult = await git.log({ maxCount: 100 });
      commitHistoryMessages = logResult.all.map((c) => c.message);

      if (
        commitHistoryMessages.length > 0 &&
        !options["silent"] &&
        !options["force"] &&
        !options["yes"]
      ) {
        log.info(
          `Including ${chalk.bold(commitHistoryMessages.length)} recent commit ${pluralize(
            commitHistoryMessages.length,
            "message",
          )} as additional context`,
        );
      }
    } catch (error) {
      log.warn(`Failed to fetch commit history: ${getErrorMessage(error)}`);
    }
  }

  const prompt = userInstruction(
    status,
    diffSummary,
    diff,
    commitHistoryMessages,
  );

  const actualTokenCount = countTokens(prompt);
  const category = categorizeTokenCount(actualTokenCount);

  if (category.needsConfirmation && !options["unsafe"]) {
    const shouldContinue = await confirm({
      message: `${chalk.bold(
        `${category.emoji ? `${category.emoji} ` : ""}Whoa there!`,
      )} ${category.description}. ${chalk.italic.dim(
        "You sure you want to burn those tokens?",
      )}`,
      initialValue: false,
    });

    if (!shouldContinue) {
      outro("Smart move. Maybe split that monster diff next time? 🤔");
      process.exit(0);
    }
  }

  let elementStream;
  try {
    const result = streamObject({
      model: aiConfig.model,
      ...(aiConfig.provider === "google" && {
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingBudget: options["thinking"] ? 2048 : 0,
              includeThoughts: options["thinking"] || false,
            },
          },
        },
      }),
      ...(aiConfig.provider === "anthropic" &&
        options["thinking"] && {
          providerOptions: {
            anthropic: {
              // Lower temperature for more deliberate reasoning in thinking mode
              temperature: 0.3,
            },
          },
        }),
      output: "array",
      schema: responseSchema,
      // OpenAI o1 models don't support system prompts, so we need to include it in the user prompt
      ...(aiConfig.provider === "openai" && options["thinking"]
        ? {
            prompt: `${systemInstruction}\n\n${prompt}`,
          }
        : {
            system: systemInstruction,
            prompt,
          }),
    });
    elementStream = result.elementStream;
  } catch (error) {
    log.error(`AI request failed: ${getErrorMessage(error)}`);
    outro("Failed to get AI assistance. Please try again later.");
    process.exit(1);
  }

  const commitSpinner = spinner();
  commitSpinner.start("Crafting commit messages that don't suck...");

  let commitCount = 0;
  try {
    for await (const response of elementStream) {
      log.message("", { symbol: chalk.gray("│") });

      if (commitCount === 0) {
        commitSpinner.stop("Here come the goods...");
      }

      for (const commit of response.commits) {
        const { commitMessage, displayMessage } = buildCommitMessages(
          commit,
          jiraTicketId,
        );

        log.message(chalk.gray("━━━"), { symbol: chalk.gray("│") });
        log.message(displayMessage, { symbol: chalk.gray("│") });

        if (commit.body?.length) {
          log.message(chalk.dim(wrapText(commit.body)), {
            symbol: chalk.gray("│"),
          });
        }

        if (commit.footers?.length) {
          log.message(
            `${commit.footers.map((footer) => wrapText(footer)).join("\n")}`,
            { symbol: chalk.gray("│") },
          );
        }

        log.message(chalk.gray("━━━"), { symbol: chalk.gray("│") });
        log.message(
          `Applies to these ${chalk.bold(
            `${commit.files.length} ${pluralize(commit.files.length, "file")}`,
          )}: ${chalk.dim(wrapText(commit.files.join(", ")))}`,
          { symbol: chalk.gray("│") },
        );

        const shouldCommit = await confirm({
          message: `Ship it?`,
        });

        if (shouldCommit) {
          let message = commitMessage;
          if (commit.body?.length) message += `\n\n${commit.body}`;
          if (commit.footers?.length)
            message += `\n\n${commit.footers.join("\n")}`;

          try {
            await git.add(commit.files);
          } catch (error) {
            log.error(
              `Dang, couldn't stage the files: ${getErrorMessage(error)}`,
            );
            process.exit(1);
          }

          try {
            const COMMIT_HASH_LENGTH = 7;
            const commitResult = await git.commit(message, commit.files);
            log.success(
              `Committed to ${commitResult.branch}: ${chalk.bold(
                commitResult.commit.slice(0, COMMIT_HASH_LENGTH),
              )} ${chalk.dim(
                `(${commitResult.summary.changes} changes, ${chalk.green(
                  "+" + commitResult.summary.insertions,
                )}, ${chalk.red("-" + commitResult.summary.deletions)})`,
              )}`,
            );
          } catch (error) {
            log.error(`Commit failed: ${getErrorMessage(error)}`);
            process.exit(1);
          }

          commitCount++;
        } else {
          log.info("Your loss, champ. Next!");
        }
      }
    }
  } catch (error) {
    commitSpinner.stop("❌ AI streaming failed");
    log.error(`Failed to process AI response: ${getErrorMessage(error)}`);
    process.exit(1);
  }

  try {
    if (commitCount > 0 && !options["force"] && !options["yes"]) {
      await handlePullRequest({
        git,
        log,
        spinner,
        confirm,
        options,
        aiConfig,
      });
    }

    if (options["push"]) {
      await handlePush({ git, log, spinner });
    }
  } catch (error) {
    log.error(`Post-commit operations failed: ${getErrorMessage(error)}`);
    process.exit(1);
  }

  if (commitCount > 0) {
    outro(
      `Boom! ${commitCount} ${pluralize(
        commitCount,
        "commit",
      )} that actually makes sense. You're welcome!`,
    );
  } else {
    outro("No commits? Time to get to work! 🙄");
    process.exit(0);
  }
}

// Graceful error handling wrapper
async function runMain() {
  try {
    await main();
  } catch (error) {
    const { log } = createPrompts({ silent: false, force: false });
    log.error(`💥 Unexpected error: ${getErrorMessage(error)}`);
    log.info("Please report this issue if it persists.");
    process.exit(1);
  }
}

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  const { log } = createPrompts({ silent: false, force: false });
  log.error(`💥 Unhandled promise rejection: ${getErrorMessage(reason)}`);
  log.info("Please report this issue if it persists.");
  process.exit(1);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  const { log } = createPrompts({ silent: false, force: false });
  log.error(`💥 Uncaught exception: ${getErrorMessage(error)}`);
  log.info("Please report this issue if it persists.");
  process.exit(1);
});

// Graceful shutdown on signals
process.on("SIGINT", () => {
  const { outro } = createPrompts({ silent: false, force: false });
  outro("👋 Interrupted by user. Goodbye!");
  process.exit(0);
});

process.on("SIGTERM", () => {
  const { outro } = createPrompts({ silent: false, force: false });
  outro("👋 Terminated. Goodbye!");
  process.exit(0);
});

runMain();
