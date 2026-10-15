# Changelog

What each release changed, as users see it. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

- Changes go under Unreleased with their commits.
- `npm run release` turns that section into the version and the date, and uses it as the GitHub Release's notes.

## Unreleased

### Added

- The pages speak English, or Chinese where your language is Chinese: the turn page, the contents, the keys and messages in the terminal; the side bar, the session list and the detail page's toolbar in VS Code. Detail pages still have some Chinese text.
- Choose the language yourself with `TICKBIRD_LANG=en|zh` (terminal) or the `tickbird.language` setting (VS Code).

## 0.8.1 - 2026-10-15

### Added

- Terminal: drag over words to select them; letting go copies them to the clipboard. Where the terminal takes the clipboard escape code (kitty, iTerm2, WezTerm) Tickbird uses it, and on a Mac the system clipboard otherwise. A click still opens the details.
- Side bar: the words of call rows, Agent rows and files in Changes can be dragged over and copied. A click still opens the details.

### Changed

- SendMessage, Skill and Workflow calls are set as Agent calls are:
  - SendMessage: "→ the task of the agent it went to", the message's summary on the line under it.
  - Skill: "◆ the skill's name", its arguments on the line under it.
  - Workflow: its name beside the tool's name, then what it does and its phases. A dot shows its state and changes colour when the background run is done.
- A subagent's page labels what it was given Task and what it gave back Result.
- The side bar's fonts follow `chat.fontSize`, `chat.fontFamily` and `chat.editor.*`, as the Claude Code extension's panel does. The other sizes scale with the body size.

### Fixed

- Side bar: the agent's words, first shown as a draft, no longer type out again from the start when they reach the record. A call shown early no longer goes away and comes back when its record comes.
- Terminal: when the agent's words come in several parts, the calls under them wait until the words are all typed.

## 0.8.0 - 2026-10-13

### Changed

- Both versions share one layout: your request is the only raised part of the page; calls sit on the page itself; Prompt, Final Answer and Changes are small grey labels.
- Colours are one ladder of greys mixed from the text and background colours. The line under the pointer or the cursor gets no colour of its own: grey text turns the body colour, and body-colour text is underlined.
- Motion is the same in both: the agent's words type out, the calls under them fade in one after another, and while waiting a gold dot breathes.

### Fixed

- A slash command the agent runs shows as the command typed, no longer as raw `<command-message>` tags.

Earlier versions: see [GitHub Releases](https://github.com/zchan0/tickbird/releases).
