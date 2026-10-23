<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg">
    <img src="docs/images/logo.svg" alt="DeepSeek Bot" width="260">
  </picture>
</p>

# DeepSeek Bot

English | [中文](README.zh.md)

![version](https://img.shields.io/badge/version-v0.1_preview-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

DeepSeek Bot (DS Bot) is a bot plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It turns DSH into bots. You create your own bots, then talk and work with them.

![Say one sentence to Chief, and it sets up the bots and the group chat](docs/images/team.png)

## Install

First install DSH and set up at least one model in it. DS Bot uses the models from DSH.

**DSH Desktop (Windows, macOS)**

1. In the sidebar, select **Plugins** → **Add plugin**.
2. In **Package name or address**, enter `ds-bot`. In mainland China, set **Registry** to **Mainland China mirror**.
3. Select **Install**, then **Enable now**. If DSH says the change takes effect at the next start, quit DSH completely and open it again.

If npm is not reachable, in step 2 you can also enter the full path of `ds-bot-0.1.7.tgz` downloaded from [Releases](https://github.com/Fei2411/DeepSeek-Bot/releases), or `github:Fei2411/DeepSeek-Bot#v0.1.7&path:/ds-bot` (needs Git).

**DSH Web (Windows, macOS, Linux)**

Needs Node.js `22.19` or later, and pnpm.

```sh
npx @deepseek-ai/dsh@0.2.0-rc.2 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.0-rc.2 web
```

**Docker (NAS, Linux server)**

The [`docker/`](docker/) directory builds an image with DSH Web and DS Bot, for a NAS or any always-on machine. The container is the Bots' sandbox: they get full access to what you mount into it, and nothing else. See [`docker/README.md`](docker/README.md).

## Setup

I strongly recommend that you set up your other bots and group chats by just talking to a bot.

## Features

### Bot

You can do all your talking and work with one bot, in one window. You don't need to worry about the context behind it. The bot's details page shows its info, and there you can pick the model you want it to use. You can switch models at any time, but I still recommend that you keep one model for a bot for a long time, and switch only when you really need to.

Bots also have memory. A bot remembers what you like and uses it in later work. You can manage its memory on the bot's details page, or just tell the bot.

![Bot details: model, memory, usage](docs/images/details.png)

### Memory

A bot's memory has three scopes:

- **Its own** — what you told this bot, and what it learned about how you like to work.
- **Project** — what was learned while working in one folder. Each project gets its own memory, so a lesson from one repository does not turn up in another. The project is identified by its Git repository; several worktrees of the same repository count as one project, and a submodule counts as its own. Without Git, the nearest project file such as `package.json` decides. A folder is a project because of what it holds, not because of its name: the team folder is a project too when it is a Git repository.
- **Team** — what the bots of the team share.

Inside a project a bot reads all three, and writes new memories to the project by default. There are two other cases, and they differ. **No project**: the folder simply has none — a folder with neither Git nor a project file, and that includes the team folder when it has neither — and the bot keeps using its own memory, reading and writing, as before. **Cannot tell**: the folder looks like it has a project but its identity cannot be read, for example a broken link in its Git metadata or a folder it cannot open. There the bot does not guess. It refuses the save and tells you why, naming `own` or `team` if you want to save anyway, and it never quietly falls back to its own memory. You can still ask for one scope in particular, and the bot's details page lets you choose which project to look at; the list of projects comes from the bot's own sessions, so a bot cannot be pointed at a project it never worked in. Memory you already have is not moved or rewritten: only new writes follow these rules.

A task lesson is not dropped when the project cannot be told apart: it is kept as a candidate and waits. When it is looked at again it is checked from the same conversation and the same original folder, and is written only if that folder still resolves to the same project; it is not meant to move to another project the bot happens to be in, or to its own memory. Whether that holds today is one of the checks listed below, and this file does not claim it yet.

Project memory can be turned off in the plugin config with `projectMemory: false`: project reads and writes are off then, a conversation that would have a project gets no project tab, and `own` and `team` keep working where they are allowed; nothing already saved is moved or rewritten. In the code as it stands, a save that names no scope then goes to the bot's own memory, so this paragraph describes what happens today, not a promise about what should happen. `memory: false` turns memory off entirely (no tools, no section, no panel), and `memoryReview: false` stops both the per-turn review and the task review, leaving unfinished candidates exactly as they are until it is on again.

Isolation is the scope of the memory API, not a filesystem sandbox: bots still read and write the files you let them reach, and memory already saved in `own` or `team` is not separated retroactively.

Search is word matching over your memory files, done on your computer. An index next to those files holds the searchable form of the entries; if it cannot be built or cannot be used, the bot reads the same Markdown directly instead, so search still works, and an entry you edit on disk is picked up on the next search. It does **not** use embeddings or vectors: a question worded with other words may not find the entry. An entry must hold every word you asked for before a partial hit is returned, and that holds when short and long words are mixed and when the index is skipped. The index decides matching and order; it is not a promise of a particular speed, and it does not claim to read less of your memory.

When a task ends, the bot can write down what it learned. `complete_task` only submits a candidate; the host looks at it after the turn. The turn ending is not acceptance, and neither is the conversation moving to a new part, a long chat being condensed, or the bot saying it is done. A task counts as done only when the bot's own log supports it, meaning the tool output, the exit status and the file contents it actually got, not what the bot says it did. Each such entry keeps a pointer to that evidence. If the bot cannot check a claim, it stays a candidate and is not written into long-term memory. If DSH is stopped while these entries are being written, the bot resumes them one at a time at the next start, from a plan it fixed once, and never writes one twice. If a line the candidate already wrote was changed by you, the candidate stops as a conflict and your line is kept. If memory is full, the entry is kept and reported to you instead of being dropped, and no retry budget is spent on it. In both cases the candidate is kept as it is, and nothing already written is repeated.

Some of the checks above are still being finished, and until they are verified this file does not claim them: a claim's evidence must come from the user, another Bot or a tool result rather than the Bot's own words (#66), input/output errors retry on their own instead of spending the same budget as a failed check (#67), the candidate keeps the project state of the folder it was reported in (#70), and the model input per candidate has one total budget (#72).

To look at what a bot keeps, open its details page and pick the memory row. The panel opens on a short summary the bot writes in the interface language. The ⋯ menu opens **All entries**, which lists them by scope and topic with their date and author, and removes one with two clicks on its remove button. The project tabs above the entries come from the bot's own conversations: **No project** shows its own and the team's memory alone, and each named project adds that project's memory. **Ask or update** sends one message to the bot from the panel, and the change it makes goes through the same rules as every other write.

### Main bot

The main bot is your chief. It has very high rights: it manages the other bots and the group chats. The first time you open DS Bot, there is already a main bot called Chief. Talk to it, and it walks you through the setup.

In short: have a question? Ask the main bot.

### Group chats

DS Bot has group chats. A group chat is a great way to get several bots to work together, but it clearly costs more. So DS Bot does this: every group chat has an admin. The admin answers your messages by default and calls in the other bots for you. You can also @ a bot directly, and it answers you directly: type @ and pick the bot from the list. To give the bots another chat as context, use + → Reference a chat in the message box.

Any bot can hand work to another bot with @. That bot does the work on its own, and the group goes on. While it works, it keeps the group posted, and the group, the sidebar and its own chat show what it is doing. When it is done, it posts the result in the group, and the bot that asked for the work answers. To stop the work, open the group's details.

![Group chat: the admin, Chief, hands the work to Writer and Coder](docs/images/group.png)

### Capabilities

Settings → **Capabilities** is a shared library of MCP servers, skills and packs. Add a capability to a Bot in its settings; it is available from that Bot's next message in its own chat and group chats. A local MCP command that a Bot adds needs your approval before it can run. While other Bots use a capability, only you or a Main Bot can change or delete it.

### Usage

In **Settings** → **Usage**, you can see token usage by time, by bot and by model.

![Usage page](docs/images/usage.png)

## Data

All data stays on your own computer, in `bot/` and `sessions/` in the DSH home folder (`~/.dsh` by default). Uninstalling the plugin does not delete this data.

Memory lives in `bot/memory/`: `bots/<id>/` for each bot's own memory, `team/` for the team's, one folder per project under `projects/<hash>/`, and the search index `index.sqlite`. The index is derived from the Markdown files: you can delete it at any time and it is rebuilt on the next search. `projects.json` records which folder each project hash belongs to, so the panel can show a name and so two folders can never share one project's memory by coincidence. `summaries/` holds the panel's saved summaries, `snapshots/` the memory section each conversation froze, `archive/` the memory of deleted bots, and `journal.jsonl` the record of each change with the line before and after. Task candidates that are still being written wait in `task-plans/`, one file each, and a record that cannot be read is moved to `task-plans/corrupt/` with its evidence kept. Editing the Markdown files by hand is allowed; the next search picks the change up.

`bot/chat-index.sqlite` holds the searchable form of the chats themselves. Like the memory index it is derived, and deleting it only costs a rebuild.

## Development

The plugin source is in [`ds-bot/`](ds-bot/). For options and internals, see [`ds-bot/README.md`](ds-bot/README.md). For development, tests and how the team works, see [CONTRIBUTING.md](CONTRIBUTING.md). For changes between versions, see [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): DS Bot is built on the DSH plugin system. Every bot works in DSH sessions and uses the DSH tools and models.
- [esbuild](https://esbuild.github.io/): bundles the plugin's interface code.
- Thanks to these projects for the ideas they published. DS Bot learned from their designs and does not contain their code:
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo): the Markdown format of Bot memory.
  - [OpenAI Codex](https://github.com/openai/codex): checkpoints that keep the user's messages next to the summary, and message anchors for chat search.
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot): group chat rounds and @mention relays.
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode): one session per member per group chat, and handoffs that carry the earlier user messages.
  - [OpenCode](https://github.com/sst/opencode), [goose](https://github.com/block/goose), [pi](https://github.com/badlogic/pi-mono) and [Gemini CLI](https://github.com/google-gemini/gemini-cli): when to condense a long chat, and what a handoff note holds.
  - [obelisk](https://github.com/tommy0103/obelisk): chat search with a SQLite full-text index.
  - [JiuwenSwarm](https://github.com/openJiuwen-ai/jiuwenswarm): keeping one memory directory per project, keyed by a hash of the project path, and recording task experience in a task data file. These are ideas only; their task experience is not checked against evidence the way it is here.
- Everyone who tries DS Bot, asks questions and reports bugs.

## License

[Apache License 2.0](LICENSE). Provided "as is", without any warranty. Third-party code and its license are listed in [NOTICE](NOTICE).

## Disclaimer

DS Bot is an independent community project. **It is not an official DeepSeek product**, and it is not affiliated with, endorsed by or sponsored by DeepSeek. "DeepSeek", "DeepSeek Harness" and the other names are trademarks of their owners. They are used here only to say what this plugin works with.

Bots use your own model quota, and they read and write files and run commands when you ask them to. Check important actions yourself.
