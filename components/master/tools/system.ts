// system tools — let the master introspect the host it's running on.
//
// Exposes hardware, OS, LM Studio model state, dev-team activity, disk
// space, and recent processes. The master can answer "what hardware are
// you on?", "which models are loaded?", "how much RAM is free?" by
// composing one or more of these.

import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";

const HOME = homedir();
const LMSTUDIO_HOST = process.env.SUBCTL_LMSTUDIO_HOST ?? "http://localhost:1234";

// macOS launchd PATH doesn't include /usr/sbin by default, so sysctl,
// vm_stat, etc. silently fail (returning "" via the catch). Force a
// known-good PATH for every shell call.
const SHELL_PATH = "/usr/sbin:/usr/bin:/bin:/sbin:/opt/homebrew/bin:/usr/local/bin";

function shell(cmd: string, opts: { timeout?: number } = {}): string {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      timeout: opts.timeout ?? 3000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PATH: SHELL_PATH },
    }).trim();
  } catch {
    return "";
  }
}

async function fetchJSON<T>(url: string, timeoutMs = 2000): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${(n / 1024 ** 4).toFixed(2)} TB`;
}

export const systemTools = {
  hardware: {
    description:
      "Get hardware info for the host the master is running on (M3 Ultra in Jason's home data center). Returns Mac model, CPU brand, physical core count, total RAM. Use when asked about hardware specs.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const model = shell("sysctl -n hw.model");
      const cpu = shell("sysctl -n machdep.cpu.brand_string");
      const cores = parseInt(shell("sysctl -n hw.physicalcpu") || "0", 10);
      const memBytes = parseInt(shell("sysctl -n hw.memsize") || "0", 10);
      const osVer = shell("sw_vers -productVersion");
      const osBuild = shell("sw_vers -buildVersion");
      const hostname = shell("hostname");
      return {
        host: hostname,
        mac_model: model,
        cpu,
        physical_cores: cores,
        ram_total: bytesHuman(memBytes),
        ram_total_bytes: memBytes,
        macos_version: osVer,
        macos_build: osBuild,
      };
    },
  },

  load: {
    description:
      "Current system load and free memory snapshot. Returns load averages, free vs used RAM, swap usage. Use when asked 'is the system under pressure?' or 'how much memory is free?'.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const uptimeOut = shell("uptime");
      // Parse `uptime`'s trailing load averages: "load averages: a, b, c"
      const loadMatch = uptimeOut.match(/load averages?:\s*([\d.]+)[, ]\s*([\d.]+)[, ]\s*([\d.]+)/);
      const loads = loadMatch
        ? { "1m": parseFloat(loadMatch[1]), "5m": parseFloat(loadMatch[2]), "15m": parseFloat(loadMatch[3]) }
        : null;
      const memBytes = parseInt(shell("sysctl -n hw.memsize") || "0", 10);
      // vm_stat reports in pages; page size from sysctl
      const pageSize = parseInt(shell("sysctl -n hw.pagesize") || "16384", 10);
      const vmOut = shell("vm_stat");
      const grab = (key: string) => {
        const m = vmOut.match(new RegExp(`${key}:\\s+(\\d+)\\.`));
        return m ? parseInt(m[1], 10) * pageSize : 0;
      };
      const pageFree = grab("Pages free");
      const pageActive = grab("Pages active");
      const pageInactive = grab("Pages inactive");
      const pageWired = grab("Pages wired down");
      const pageCompressed = grab("Pages occupied by compressor");
      return {
        load_averages: loads,
        ram: {
          total: bytesHuman(memBytes),
          free: bytesHuman(pageFree),
          active: bytesHuman(pageActive),
          inactive: bytesHuman(pageInactive),
          wired: bytesHuman(pageWired),
          compressed: bytesHuman(pageCompressed),
        },
        uptime_raw: uptimeOut,
      };
    },
  },

  disk: {
    description:
      "Free disk space on the host's main volume. Returns total / used / available with percentages. Use when asked about storage or before downloading large model weights.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const out = shell("df -h /");
      const lines = out.split("\n");
      const data = lines[1] ?? "";
      const cols = data.split(/\s+/);
      // df -h: Filesystem Size Used Avail Capacity iused ifree %iused Mounted
      return {
        filesystem: cols[0],
        size: cols[1],
        used: cols[2],
        available: cols[3],
        capacity: cols[4],
        mounted_on: cols[8] ?? "/",
        raw: out,
      };
    },
  },

  lmstudio_models: {
    description:
      "List ALL models known to the LM Studio server: which are loaded, their type (llm/vlm/embeddings), quantization, max context, capabilities (tool_use, etc.). Use when asked about available models, what's loaded, or to recommend a model for a task.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      // Native LM Studio API (richer than OpenAI-compat /v1/models)
      const native = await fetchJSON<{ data: Array<Record<string, unknown>> }>(
        `${LMSTUDIO_HOST}/api/v0/models`,
        2500,
      );
      if (!native) {
        return { ok: false, error: "LM Studio API unreachable", host: LMSTUDIO_HOST };
      }
      const models = native.data ?? [];
      const loaded = models.filter((m) => m.state === "loaded");
      return {
        ok: true,
        host: LMSTUDIO_HOST,
        total: models.length,
        loaded_count: loaded.length,
        loaded_ids: loaded.map((m) => m.id),
        models: models.map((m) => ({
          id: m.id,
          type: m.type,
          state: m.state,
          publisher: m.publisher,
          arch: m.arch,
          quantization: m.quantization,
          max_context_length: m.max_context_length,
          loaded_context_length: m.loaded_context_length,
          capabilities: m.capabilities ?? [],
        })),
      };
    },
  },

  tmux_sessions: {
    description:
      "List every tmux session on the host (orchestrator + non-orchestrator alike). Returns name, path, attached, age, env CLAUDE_CONFIG_DIR if set. Use when asked what's running or to find a specific session.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const out = shell(
        `tmux list-sessions -F '#{session_name}\t#{session_path}\t#{session_attached}\t#{session_created}'`,
      );
      if (!out) return { sessions: [], note: "no tmux sessions or tmux not running" };
      const sessions = out.split("\n").map((line) => {
        const [name, path, attached, created] = line.split("\t");
        const claudeCfg = shell(`tmux show-environment -t ${name} CLAUDE_CONFIG_DIR 2>/dev/null`);
        return {
          name,
          path,
          attached: attached === "1",
          age_seconds: Math.floor(Date.now() / 1000) - parseInt(created, 10),
          claude_config_dir: claudeCfg.split("=")[1] ?? null,
          is_dev_team: claudeCfg.includes("="),
        };
      });
      return { sessions };
    },
  },

  process_top: {
    description:
      "Top processes by CPU% or RAM. Use when asked 'what's eating CPU?' or 'why is the system slow?'. Returns top 8 by the requested metric.",
    schema: {
      type: "object",
      properties: {
        sort_by: {
          type: "string",
          enum: ["cpu", "mem"],
          description: "Sort by 'cpu' or 'mem'. Default cpu.",
        },
      },
      required: [],
    },
    invoke: async ({ sort_by }: { sort_by?: "cpu" | "mem" } = {}) => {
      const flag = sort_by === "mem" ? "-rss" : "-cpu";
      const out = shell(`ps -A -r -o pid,user,%cpu,%mem,command | head -10`);
      // -r sorts by cpu by default; for mem sort, redo:
      const cmd = sort_by === "mem"
        ? `ps -A -m -o pid,user,%cpu,%mem,command | head -10`
        : `ps -A -r -o pid,user,%cpu,%mem,command | head -10`;
      const ranked = shell(cmd);
      return { sort_by: sort_by ?? "cpu", top: ranked || out };
    },
  },

  projects_dir: {
    description:
      "List code projects under ~/code on the host. Returns name, last commit, branch, has CLAUDE.md, has package.json. Use when asked what projects exist or to identify candidates for a dev team.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      const codeRoot = `${HOME}/code`;
      const dirs = shell(`ls -1d ${codeRoot}/*/ 2>/dev/null`);
      if (!dirs) return { projects: [], code_root: codeRoot };
      const projects = dirs.split("\n").map((d) => {
        const path = d.replace(/\/$/, "");
        const name = path.split("/").pop() ?? path;
        const lastCommit = shell(`git -C ${path} log -1 --format='%h %s (%cr)' 2>/dev/null`);
        const branch = shell(`git -C ${path} rev-parse --abbrev-ref HEAD 2>/dev/null`);
        let hasClaude = false, hasPkgJson = false;
        try { statSync(`${path}/CLAUDE.md`); hasClaude = true; } catch { /* no */ }
        try { statSync(`${path}/package.json`); hasPkgJson = true; } catch { /* no */ }
        return {
          name,
          path,
          branch: branch || null,
          last_commit: lastCommit || null,
          has_claude_md: hasClaude,
          has_package_json: hasPkgJson,
        };
      });
      return { code_root: codeRoot, projects };
    },
  },

  daemon_self: {
    description:
      "Information about THIS subctl master daemon process: PID, uptime, transcript size, config paths, tools count, supervisor model. Use when asked 'what's your status' or 'where do you live'.",
    schema: { type: "object", properties: {}, required: [] },
    invoke: async () => {
      return {
        pid: process.pid,
        uptime_seconds: Math.floor(process.uptime()),
        bun_version: process.versions.bun,
        node_compat: process.versions.node,
        config_dir: process.env.SUBCTL_CONFIG_DIR ?? `${HOME}/.config/subctl`,
        master_state_dir: `${process.env.SUBCTL_CONFIG_DIR ?? `${HOME}/.config/subctl`}/master`,
        log_path: `${HOME}/Library/Logs/subctl/master.log`,
        plist_path: `${HOME}/Library/LaunchAgents/com.subctl.master.plist`,
        http_host: process.env.SUBCTL_MASTER_HOST ?? "127.0.0.1",
        http_port: process.env.SUBCTL_MASTER_PORT ?? "8788",
      };
    },
  },

  my_tools: {
    description:
      "List the tools currently registered in this master daemon's tool registry. Use when asked 'what tools do you have', 'what can you do', or before claiming a specific tool exists. Returns each tool's name + description so you can answer accurately. Names come from the live registry, not from memory — master SKILL anti-hallucination rule #2 (don't claim capabilities you don't have) is enforced by calling this.",
    schema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Optional substring to filter tool names by (case-insensitive). E.g. 'subctl_orch' to see just the orchestration tools.",
        },
      },
      required: [],
    },
    invoke: async (args: { filter?: string }) => {
      const reg = _toolRegistryRef;
      if (!reg) {
        return {
          ok: false,
          error: "tool registry not yet bound — daemon is mid-boot. Try again in a moment.",
        };
      }
      const filter = (args.filter ?? "").trim().toLowerCase();
      const out = Object.entries(reg)
        .filter(([name]) => !filter || name.toLowerCase().includes(filter))
        .map(([name, t]) => ({
          name,
          description: (t as { description?: string }).description ?? "(no description)",
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        ok: true,
        total: Object.keys(reg).length,
        count: out.length,
        tools: out,
      };
    },
  },
};

// Late-binder pattern: server.ts calls bindToolRegistry(registry) at boot
// so my_tools can introspect the live registry without creating a circular
// import. Without this binder my_tools would have to import from server.ts,
// which already imports systemTools — Bun's ESM cycle handling would make
// the registry undefined at import time.
let _toolRegistryRef: Record<string, { description?: string }> | null = null;
export function bindToolRegistry(reg: Record<string, { description?: string }>): void {
  _toolRegistryRef = reg;
}
