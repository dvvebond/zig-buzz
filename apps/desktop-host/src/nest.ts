import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const NEST_DIRECTORIES = [
  "GUIDES",
  "RESEARCH",
  "PLANS",
  "WORK_LOGS",
  "OUTBOX",
  ".scratch",
] as const;
const SKILL_PARENT_DIRECTORIES = [
  ".agents/skills",
  ".claude/skills",
  ".codex/skills",
  ".goose/skills",
] as const;
const CANONICAL_SKILL_DIRECTORY = ".agents/skills/buzz-cli";
const AGENTS_TEMPLATE_VERSION = 5;
const SKILL_TEMPLATE_VERSION = 5;
const BEGIN_MARKER = "<!-- BEGIN BUZZ MANAGED";
const END_MARKER = "<!-- END BUZZ MANAGED -->";

export type NestAgent = {
  readonly name?: unknown;
  readonly persona_id?: unknown;
  readonly personaId?: unknown;
};

/**
 * Owns the persistent, shared workspace used as the cwd for local ACP agents.
 * Every path is rooted beneath an explicitly resolved directory, roots and
 * managed directories may not be symlinks, and existing user files are never
 * silently replaced.
 */
export class NestService {
  readonly #agentsTemplate: string;
  readonly #root: string;
  readonly #skillTemplate: string;

  private constructor(input: {
    agentsTemplate: string;
    root: string;
    skillTemplate: string;
  }) {
    this.#agentsTemplate = input.agentsTemplate;
    this.#root = path.resolve(input.root);
    this.#skillTemplate = input.skillTemplate;
  }

  static async create(root: string): Promise<NestService> {
    const [agentsTemplate, skillTemplate] = await Promise.all([
      readFile(new URL("../assets/nest-agents.md", import.meta.url), "utf8"),
      readFile(new URL("../assets/buzz-cli-skill.md", import.meta.url), "utf8"),
    ]);
    return new NestService({ agentsTemplate, root, skillTemplate });
  }

  root(): string {
    return this.#root;
  }

  async ensure(): Promise<void> {
    await ensureRealDirectory(this.#root);
    for (const name of NEST_DIRECTORIES) {
      await ensureRealDirectory(path.join(this.#root, name));
    }
    const repos = path.join(this.#root, "REPOS");
    const reposMetadata = await metadata(repos);
    if (!reposMetadata) {
      await ensureRealDirectory(repos);
    } else if (
      !reposMetadata.isDirectory() &&
      !reposMetadata.isSymbolicLink()
    ) {
      throw new Error("Buzz Nest REPOS must be a directory or directory link");
    }
    for (const name of SKILL_PARENT_DIRECTORIES) {
      await ensureRealDirectory(path.join(this.#root, name));
    }
    await ensureRealDirectory(path.join(this.#root, CANONICAL_SKILL_DIRECTORY));

    const agentsPath = path.join(this.#root, "AGENTS.md");
    await createFileIfMissing(agentsPath, this.#agentsTemplate);
    await rejectLinkOrNonFile(agentsPath);
    const skillPath = path.join(
      this.#root,
      CANONICAL_SKILL_DIRECTORY,
      "SKILL.md",
    );
    await createFileIfMissing(skillPath, this.#skillTemplate);
    await rejectLinkOrNonFile(skillPath);

    await this.#refreshAgentsTemplate(agentsPath);
    await this.#refreshSkillTemplate(skillPath);
    await this.#ensureSkillLinks();
    await this.#lockPermissions();
  }

  async regenerate(
    agents: readonly NestAgent[],
    relayUrl: string,
  ): Promise<void> {
    await this.ensure();
    const agentsPath = path.join(this.#root, "AGENTS.md");
    const current = await readFile(agentsPath, "utf8");
    const active =
      agents.length === 0
        ? "## Active Agents\n\n*(No agents deployed yet. Add agents in the Buzz desktop app.)*"
        : [
            "## Active Agents",
            "",
            "| Name | Persona | How to address |",
            "|------|---------|----------------|",
            ...agents.map((agent) => {
              const name = markdownCell(agent.name, "Unnamed agent");
              const persona = markdownCell(
                agent.persona_id ?? agent.personaId,
                "—",
              );
              return `| ${name} | ${persona} | @${name} |`;
            }),
          ].join("\n");
    const safeRelay = relayUrl.replaceAll(/[\r\n]/g, "").slice(0, 2_048);
    const section = `${active}\n\n## Workspace\n- Relay: ${safeRelay}`;
    const next = upsertManagedSection(current, section);
    if (next !== current) await atomicWrite(agentsPath, next);
  }

  async setReposDirectory(directory: string | null): Promise<void> {
    await this.ensure();
    const repos = path.join(this.#root, "REPOS");
    const current = await metadata(repos);
    if (directory === null) {
      if (current?.isSymbolicLink()) await unlink(repos);
      await ensureRealDirectory(repos);
      return;
    }
    const target = path.resolve(directory);
    if (!path.isAbsolute(directory) || target === this.#root) {
      throw new Error("repository directory must be an external absolute path");
    }
    if (current?.isSymbolicLink()) {
      await unlink(repos);
    } else if (current?.isDirectory()) {
      if ((await readdir(repos)).length > 0) {
        throw new Error(
          "Buzz Nest REPOS is not empty; move its repositories before changing the repository directory",
        );
      }
      await rmdir(repos);
    } else if (current) {
      throw new Error("Buzz Nest REPOS has an unsupported file type");
    }
    await symlink(
      target,
      repos,
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  async #refreshAgentsTemplate(agentsPath: string): Promise<void> {
    const versionPath = path.join(this.#root, ".nest-agents-version");
    if ((await readVersion(versionPath)) >= AGENTS_TEMPLATE_VERSION) return;
    const current = await readFile(agentsPath, "utf8");
    const currentMarker = markerAtLineStart(current, BEGIN_MARKER);
    const templateMarker = markerAtLineStart(
      this.#agentsTemplate,
      BEGIN_MARKER,
    );
    const next =
      currentMarker === undefined
        ? this.#agentsTemplate
        : `${staticPrefix(this.#agentsTemplate, templateMarker)}${current.slice(
            lineStart(current, currentMarker),
          )}`;
    await atomicWrite(agentsPath, next);
    await atomicWrite(versionPath, `${AGENTS_TEMPLATE_VERSION}\n`, 0o600);
  }

  async #refreshSkillTemplate(skillPath: string): Promise<void> {
    const versionPath = path.join(
      this.#root,
      CANONICAL_SKILL_DIRECTORY,
      ".skill-version",
    );
    if ((await readVersion(versionPath)) >= SKILL_TEMPLATE_VERSION) return;
    await atomicWrite(skillPath, this.#skillTemplate);
    await atomicWrite(versionPath, `${SKILL_TEMPLATE_VERSION}\n`, 0o600);
  }

  async #ensureSkillLinks(): Promise<void> {
    for (const parentName of [
      ".claude/skills",
      ".codex/skills",
      ".goose/skills",
    ]) {
      const link = path.join(this.#root, parentName, "buzz-cli");
      if (await metadata(link)) continue;
      if (process.platform === "win32") {
        await ensureRealDirectory(link);
        await createFileIfMissing(
          path.join(link, "SKILL.md"),
          this.#skillTemplate,
        );
      } else {
        const depth = parentName.split("/").length;
        const target = `${"../".repeat(depth)}${CANONICAL_SKILL_DIRECTORY}`;
        await symlink(target, link, "dir");
      }
    }
  }

  async #lockPermissions(): Promise<void> {
    if (process.platform === "win32") return;
    const directories = [
      this.#root,
      ...NEST_DIRECTORIES.map((name) => path.join(this.#root, name)),
      path.join(this.#root, "REPOS"),
      ...SKILL_PARENT_DIRECTORIES.map((name) => path.join(this.#root, name)),
      path.join(this.#root, CANONICAL_SKILL_DIRECTORY),
    ];
    for (const directory of directories) {
      const details = await metadata(directory);
      if (details && !details.isSymbolicLink()) await chmod(directory, 0o700);
    }
  }
}

export function upsertManagedSection(current: string, section: string): string {
  const replacement = `${BEGIN_MARKER} — regenerated automatically, do not edit below -->\n${section}\n${END_MARKER}\n`;
  const begin = markerAtLineStart(current, BEGIN_MARKER);
  if (begin === undefined) {
    return `${stripOrphanMarker(current).trimEnd()}\n\n${replacement}`;
  }
  const end = markerAtLineStart(current, END_MARKER, begin);
  if (end === undefined) {
    return `${stripMarkerLine(current, begin).trimEnd()}\n\n${replacement}`;
  }
  const afterEnd = end + END_MARKER.length;
  const suffixStart = current[afterEnd] === "\n" ? afterEnd + 1 : afterEnd;
  return `${current.slice(0, lineStart(current, begin))}${replacement}${current.slice(
    suffixStart,
  )}`;
}

async function ensureRealDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`${directory} must be a real directory`);
  }
}

async function createFileIfMissing(
  file: string,
  content: string,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(content, "utf8");
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  } finally {
    await handle?.close();
  }
}

async function rejectLinkOrNonFile(file: string): Promise<void> {
  const details = await lstat(file);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`${file} must be a regular file`);
  }
}

async function metadata(
  file: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(file);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readVersion(file: string): Promise<number> {
  try {
    const value = Number.parseInt((await readFile(file, "utf8")).trim(), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }
}

async function atomicWrite(
  file: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function markerAtLineStart(
  content: string,
  marker: string,
  from = 0,
): number | undefined {
  let position = content.indexOf(marker, from);
  while (position >= 0) {
    if (position === 0 || content[position - 1] === "\n") return position;
    position = content.indexOf(marker, position + 1);
  }
  return undefined;
}

function lineStart(content: string, position: number): number {
  return content.lastIndexOf("\n", position - 1) + 1;
}

function staticPrefix(template: string, marker: number | undefined): string {
  return marker === undefined
    ? template
    : template.slice(0, lineStart(template, marker));
}

function stripOrphanMarker(content: string): string {
  const begin = markerAtLineStart(content, BEGIN_MARKER);
  return begin === undefined ? content : stripMarkerLine(content, begin);
}

function stripMarkerLine(content: string, position: number): string {
  const start = lineStart(content, position);
  const nextNewline = content.indexOf("\n", position);
  const end = nextNewline < 0 ? content.length : nextNewline + 1;
  return `${content.slice(0, start)}${content.slice(end)}`;
}

function markdownCell(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .trim()
    .replaceAll("|", "\\|")
    .replaceAll(/[\r\n]/g, " ")
    .slice(0, 256);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
