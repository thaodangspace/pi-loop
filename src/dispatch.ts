/**
 * Safe, unified dispatch for the prompts a scheduled loop delivers.
 *
 * Pi's `sendUserMessage` does not process text by default: `expandPromptTemplates`
 * defaults to false, so a leading `/` is delivered literally. Interactive input
 * behaves differently — Pi can expand prompt templates and skill commands, and,
 * before either, *executes* a matching extension command. A scheduled prompt
 * wants the useful half of that behavior (skills and prompt templates) without
 * ever executing a command: scheduling `/loop stop`, `/reload`, or any other
 * extension command from a loop would otherwise run it.
 *
 * This module classifies a scheduled prompt against the session's actual slash
 * commands (`pi.getCommands()`, which reports each command's source) and replies:
 *
 * - plain text and unrecognized slash text: send literally and exactly;
 * - a known skill command or prompt template: send with Pi's expansion enabled;
 * - an extension command, a built-in interactive command, or an unknown
 *   `skill:` command: reject without sending, and report why.
 *
 * Contract observed in Pi 0.87.1 (installed `@earendil-works/pi-coding-agent`):
 *
 * - `AgentSession.sendUserMessage(content, options)` forwards
 *   `expandPromptTemplates: options?.expandPromptTemplates ?? false` to
 *   `prompt()` (`dist/core/agent-session.js`).
 * - `prompt()` with expansion on first tries an extension command using the text
 *   up to the first space (`_tryExecuteExtensionCommand`), then expands
 *   `/skill:<name>` (`_expandSkillCommand`), then applies `expandPromptTemplate`.
 * - `getCommands()` reports extension commands (`source: "extension"`), prompt
 *   templates (`source: "prompt"`), and skills as `skill:<name>`
 *   (`source: "skill"`). Built-in interactive commands are not part of it.
 *
 * Nothing here imports the Pi runtime, so classification is fully unit-testable.
 */

/** The source Pi attributes to a slash command; mirrors `SlashCommandSource`. */
export type SlashCommandSource = "extension" | "prompt" | "skill";

/** The subset of `pi.getCommands()` the classifier needs. */
export interface SlashCommandLike {
  readonly name: string;
  readonly source: SlashCommandSource;
}

/**
 * Pi's built-in interactive/session commands. They are handled by the editor,
 * never by `sendUserMessage`, but a scheduled prompt named after one is a
 * mistake and is rejected explicitly. Kept in sync with Pi's
 * `BUILTIN_SLASH_COMMANDS` by a test that reads the installed package.
 */
export const INTERACTIVE_SLASH_COMMANDS: readonly string[] = [
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "bug",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
];

const INTERACTIVE_COMMANDS: ReadonlySet<string> = new Set(INTERACTIVE_SLASH_COMMANDS);

/** Why a scheduled prompt was rejected. */
export type ScheduledPromptRejectKind = "extension-command" | "interactive-command" | "unknown-skill";

/** The classified form of a scheduled prompt. `text` is always the original input. */
export type ScheduledPromptDecision =
  | { readonly action: "literal"; readonly text: string }
  | { readonly action: "expand"; readonly text: string; readonly command: SlashCommandLike }
  | {
      readonly action: "reject";
      readonly text: string;
      readonly kind: ScheduledPromptRejectKind;
      /** The command name as it appears after `/` (or `skill:<name>`). */
      readonly name: string;
      /** A user-facing explanation of the rejection. */
      readonly reason: string;
    };

/**
 * The extension-command name Pi would use: the text after `/` up to the first
 * ASCII space. Mirrors `_tryExecuteExtensionCommand`, which splits on `" "`.
 */
function extensionCommandName(text: string): string {
  const space = text.indexOf(" ");
  return space === -1 ? text.slice(1) : text.slice(1, space);
}

/** The skill name Pi would use for `/skill:<name>`, or undefined for other text. */
function skillCommandName(text: string): string | undefined {
  if (!text.startsWith("/skill:")) {
    return undefined;
  }
  const space = text.indexOf(" ");
  return space === -1 ? text.slice(7) : text.slice(7, space);
}

/** The prompt-template name Pi would use (`^\/([^\s]+)`), or undefined. */
function templateCommandName(text: string): string | undefined {
  return /^\/([^\s]+)/.exec(text)?.[1];
}

function rejection(
  kind: ScheduledPromptRejectKind,
  name: string,
  text: string,
): Extract<ScheduledPromptDecision, { action: "reject" }> {
  const reason =
    kind === "extension-command"
      ? `\`/${name}\` is a Pi extension command; a scheduled loop will not run extension commands (they can trigger session control such as \`/loop stop\` or \`/reload\`). Remove the leading \`/\` to send the text literally, or schedule a prompt template or skill instead.`
      : kind === "interactive-command"
        ? `\`/${name}\` is an interactive Pi command and cannot run from a scheduled loop. Remove the leading \`/\` to send the text literally.`
        : `\`/skill:${name}\` does not name a loaded skill.`;
  return { action: "reject", text, kind, name, reason };
}

/**
 * Classify a scheduled prompt against the session's slash commands.
 *
 * `commands` is normally `pi.getCommands()`. The original `text` is returned
 * unchanged in every decision, so a literal send can preserve it exactly.
 */
export function classifyScheduledPrompt(
  text: string,
  commands: readonly SlashCommandLike[],
): ScheduledPromptDecision {
  // Plain text — and text that does not open a slash command at all — is always
  // sent exactly as written.
  if (!text.startsWith("/")) {
    return { action: "literal", text };
  }

  // An extension command would be *executed* by Pi when expansion is on, so it
  // is rejected before anything else. `getCommands()` and `getCommand()` use the
  // same invocation name, so this fully covers what `prompt()` would execute.
  const extensionName = extensionCommandName(text);
  const extension = commands.find(
    (command) => command.source === "extension" && command.name === extensionName,
  );
  if (extension) {
    return rejection("extension-command", extensionName, text);
  }

  // Built-in interactive commands are never handled by `sendUserMessage`, but
  // scheduling one is still a mistake. This check wins over a template or skill
  // that happens to share the name, so control names can never be scheduled.
  const firstToken = text.slice(1).split(/\s/, 1)[0] ?? "";
  if (INTERACTIVE_COMMANDS.has(firstToken)) {
    return rejection("interactive-command", firstToken, text);
  }

  // A known skill command expands to the skill's content.
  const skillName = skillCommandName(text);
  if (skillName !== undefined) {
    const skill = commands.find(
      (command) => command.source === "skill" && command.name === `skill:${skillName}`,
    );
    if (skill) {
      return { action: "expand", text, command: skill };
    }
    return rejection("unknown-skill", skillName, text);
  }

  // A known prompt template expands to its content.
  const templateName = templateCommandName(text);
  if (templateName !== undefined) {
    const template = commands.find(
      (command) => command.source === "prompt" && command.name === templateName,
    );
    if (template) {
      return { action: "expand", text, command: template };
    }
  }

  // Unknown slash text is ordinary literal text: a path such as
  // `/etc/hosts`, prose, or any command that is not loaded in this session.
  return { action: "literal", text };
}

/** Thrown instead of sending a scheduled prompt that the policy rejects. */
export class ScheduledPromptRejectedError extends Error {
  /** The rejection decision, so callers can report the kind and name. */
  readonly decision: Extract<ScheduledPromptDecision, { action: "reject" }>;

  constructor(decision: Extract<ScheduledPromptDecision, { action: "reject" }>) {
    super(decision.reason);
    this.name = "ScheduledPromptRejectedError";
    this.decision = decision;
  }
}

/** Injected Pi surface used by the dispatcher. */
export interface ScheduledPromptDispatchDeps {
  /** The session's current slash commands, normally `() => pi.getCommands()`. */
  commands(): readonly SlashCommandLike[];
  /**
   * Deliver the text as a user message. `expandPromptTemplates` is Pi's
   * `sendUserMessage` option: true runs skill/template expansion, false sends
   * the text literally.
   */
  send(text: string, options: { expandPromptTemplates: boolean }): void;
}

/** The single entry point scheduled runs use to deliver their prompt. */
export interface ScheduledPromptDispatcher {
  /** Classify without sending. */
  classify(text: string): ScheduledPromptDecision;
  /**
   * Classify and deliver. Literal text is sent exactly with expansion off;
   * skills and templates are sent with expansion on. A rejected form is never
   * sent: this throws {@link ScheduledPromptRejectedError} instead.
   */
  dispatch(text: string): ScheduledPromptDecision;
}

/**
 * Build the dispatcher used by every scheduled path (fixed, self-paced, and
 * maintenance). It reads the live command list on every call so a `/reload`
 * that changes skills or templates is honored on the next run.
 */
export function createScheduledPromptDispatcher(
  deps: ScheduledPromptDispatchDeps,
): ScheduledPromptDispatcher {
  const classify = (text: string): ScheduledPromptDecision =>
    classifyScheduledPrompt(text, deps.commands());

  return {
    classify,
    dispatch(text: string): ScheduledPromptDecision {
      const decision = classify(text);
      if (decision.action === "reject") {
        throw new ScheduledPromptRejectedError(decision);
      }
      // Send the original text, never a rewritten copy, so a literal prompt is
      // byte-for-byte what the user scheduled.
      deps.send(text, { expandPromptTemplates: decision.action === "expand" });
      return decision;
    },
  };
}
