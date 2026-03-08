# Research: How Evolvo Could Create Real Design Artifacts and Build from Them

Date: 2026-03-08

## Executive summary

Evolvo can already produce one class of "real design" today: a code-first design artifact made from a static or semi-static prototype, supported by screenshots and a structured design spec. That is stronger than vague design notes because it is rendered, reviewable, and directly convertible into implementation work.

Evolvo cannot yet produce a strong tool-native visual design artifact such as a Figma file, Penpot file, or clickable prototype with a first-class review loop from inside the repository alone. The current runtime is optimized for code, issues, validation, and GitHub flow, not for visual editing, versioned mockups, or design review state.

The strongest practical path is a staged model:

1. Use code-first prototypes as the immediate design artifact Evolvo can create now.
2. Add a component artifact layer such as Storybook so designs become reusable, reviewable UI states instead of ad hoc pages.
3. If a real external design tool is required, prefer:
   - Figma MCP + Code Connect when the team already works in Figma and wants the strongest design-to-code bridge.
   - Penpot when Evolvo should own more of the design system and workflow in an open, self-hostable stack.
4. Treat image generation as a support tool for concept exploration, not as the final design source of truth.

## 1. What counts as a "real design" for Evolvo

A real design artifact is not just text that says "make it modern" or "use a clean layout." For Evolvo, a real design needs to be specific enough that implementation can follow without re-inventing the product in code.

At minimum, a build-driving design artifact should contain:

- A visual artifact: wireframe, mockup, rendered page, clickable prototype, or component gallery.
- A structural artifact: layout rules, component inventory, state variants, responsive behavior, hierarchy.
- An implementation artifact: design tokens, asset references, content constraints, interaction notes, accessibility expectations.

The useful distinction is:

- Vague design idea:
  - "Landing page with a premium feel"
  - "Use a soft blue palette"
  - "Make the dashboard clearer"
- Real design deliverable:
  - a rendered homepage or dashboard layout
  - explicit components and states
  - spacing, typography, color, and responsive rules
  - enough detail to build without guessing

For Evolvo, there are four meaningful artifact levels:

1. Text brief only
   - Useful for direction, but not a design deliverable.
2. Structured design spec
   - Better, but still not sufficiently visual on its own.
3. Rendered artifact
   - Static mockup, storybook page, prototype page, Figma/Penpot screen, or clickable prototype.
4. Build-ready design package
   - Rendered artifact plus tokens, component states, behavior notes, and traceability into code.

The target should be level 4.

## 2. What Evolvo can already do today

Based on the current repository:

- Evolvo's coding agent runs with `workspace-write`, network access, and web search enabled in `src/agents/codingAgent.ts`.
- Evolvo can already write repository files, Markdown research/spec documents, HTML/CSS/JS/TS/React code, and create PR-reviewed outputs.
- `src/agents/runCodingAgent.ts` shows that Codex runs can use web search and can log MCP tool calls when the host exposes them.
- The repository does not currently include first-class design tooling such as Figma, Penpot, Storybook, visual regression tooling, or image generation integrations.
- The repository does not currently model design artifacts as canonical runtime objects. There is no design artifact store, no design review state machine, and no implementation flow that treats a design file as a first-class source of truth.

That means Evolvo's current design-adjacent capabilities are:

- Strong:
  - writing design briefs and specs
  - generating code-first mockups and prototypes
  - encoding styles as tokens, CSS variables, components, and layouts
  - using GitHub PR review as a review surface
- Weak:
  - creating tool-native visual artifacts
  - iterating visually without coding
  - preserving design intent independently from implementation code
  - reviewing design quality with strong visual judgment

## 3. The strongest design strategies available to Evolvo

| Strategy | Is it a real design artifact? | What Evolvo can do with it today | Main strength | Main weakness | Recommendation |
| --- | --- | --- | --- | --- | --- |
| Text-only design brief | No | Fully | Fast and cheap | Too vague to drive build quality | Use only as input |
| Structured design spec | Partial | Fully | Good for clarity and traceability | Still not visual enough | Required companion artifact |
| Code-first mockup/prototype | Yes | Fully | Immediate, buildable, repo-native | Can collapse design into engineering too early | Best current-state option |
| Storybook component/page states | Yes | Not present yet, but straightforward to add | Reusable UI states, docs, testing, stakeholder review | More implementation-shaped than freeform design | Best medium-term internal layer |
| Figma-based workflow | Yes | Requires external integration | Industry-standard design review and component mapping | Plan/access cost, tool split, not fully autonomous by default | Best external bridge for teams already in Figma |
| Penpot-based workflow | Yes | Requires external integration | Open, self-hostable, design-as-code alignment | Smaller ecosystem, additional infra | Best open stack option |
| Image-generation-led workflow | Sometimes, but weak | Requires explicit image generation tooling | Fast exploration of directions | Not build-ready, weak precision, easy to fake quality | Use only for concept exploration |
| Hybrid human-approved workflow | Yes | Possible if review surface is added | Best quality control | Slower, requires approval loop | Strongest quality path overall |

## 4. Practical options Evolvo could use

### Option A: Code-first design artifact inside the repo

This is the lowest-friction option and the one Evolvo can already do now.

Artifact shape:

- a prototype page or small prototype app
- screenshots for desktop/mobile/tablet
- a Markdown design brief/spec
- design tokens and component list

Workflow:

1. Gather requirements.
2. Write a design brief.
3. Generate a static prototype in code.
4. Capture screenshots.
5. Review and revise the artifact.
6. Promote prototype pieces into real components/pages.

Why it works:

- Evolvo is already good at code generation and file edits.
- The artifact lives in Git and can be reviewed like any other change.
- The "design" is directly executable.

Where it fails:

- It can confuse design exploration with implementation.
- It is hard to make large visual changes quickly.
- Weak visual taste can produce polished-looking but badly designed output.

Best use:

- marketing sites
- landing pages
- dashboard shells
- component libraries
- internal tools where speed matters more than designer-native workflows

### Option B: Storybook as the ongoing design artifact layer

Storybook is a strong fit once Evolvo has a componentized frontend.

Why it matters:

- Storybook presents components and pages in isolation.
- Stories capture known-good visual states.
- It supports documentation, sharing, UI review, and automated UI testing.
- Official Storybook docs explicitly position it as a place to build components and pages in isolation, document them, and publish them for review.

For Evolvo, Storybook would turn "design" from a single page mockup into:

- reusable component states
- variant documentation
- design system reference pages
- a stakeholder review surface

This is not the best tool for initial freeform concepting, but it is the best internal artifact once a design direction exists.

### Option C: Figma-centered design-to-build workflow

Figma is the strongest external choice if the goal is a recognizable, tool-native design workflow.

Relevant official capabilities:

- Figma's MCP server can provide selected-frame context, variables, components, and layout data to AI agents.
- Figma's docs are explicit that MCP is not "design to perfect code"; it is a bridge that provides structured design input and a starting point.
- Code Connect can map Figma library components to code paths in the repository and attach extra AI instructions.
- Dev Resources can attach repository URLs, issues, or PRs back to nodes in Dev Mode.

Implications for Evolvo:

- Figma is good when design is approved visually first, then translated into code.
- Evolvo could use Figma as the visual source of truth and the repo as the implementation source of truth.
- Code Connect reduces the gap between design components and real repository components.
- Dev Resources could link frames and nodes back to GitHub issues, implementation PRs, or research docs.

Main limits:

- Access depends on plan and seat type.
- Figma MCP has rate limits.
- Figma's own docs warn that output quality depends on context quality, prompt quality, and component mapping.
- Figma is better at design-to-code handoff than at fully autonomous design generation from nothing.

Best use:

- teams already using Figma
- products needing high-fidelity visual review
- cases where human design approval matters before build starts

### Option D: Penpot-centered design-to-build workflow

Penpot is the strongest open/self-hostable option.

Relevant official capabilities:

- Penpot positions itself as a design-and-code collaboration platform with open API, MCP server, webhooks, and plugin system.
- Penpot's inspect mode exposes specs plus CSS, HTML, and SVG snippets.
- Penpot explicitly frames layouts in terms of web standards such as CSS Grid and Flex layouts.
- Penpot plugins can be built in JavaScript or TypeScript and communicate with Penpot through a message-based API.

Implications for Evolvo:

- Penpot aligns better than most design tools with an autonomous, repo-centric, open workflow.
- A Penpot file can act as a real visual artifact while still speaking in code-shaped primitives.
- Self-hosting lowers vendor lock-in and makes tighter automation more realistic.

Main limits:

- Smaller ecosystem than Figma.
- Less likely that a team already has design operations there.
- Evolvo would still need explicit workflow glue around artifact review and implementation traceability.

Best use:

- open-source or self-hosted product stacks
- teams that want deeper automation control
- organizations that want design artifacts without locking into Figma

### Option E: Image generation for concept exploration

This is useful only as an upstream ideation tool.

Relevant official capability:

- OpenAI's image generation docs support prompt-based creation and iterative multi-turn editing in the Responses API.

What it can help with:

- moodboards
- rough stylistic directions
- hero image concepts
- early layout exploration

What it should not be used for:

- final UI layout source of truth
- exact spacing and responsive rules
- accessibility-driven component design
- implementation without an intermediate structured artifact

Recommendation:

- use it to widen option space
- never use it as the only design artifact

## 5. A practical design workflow for Evolvo

There are two realistic workflows worth recommending.

### Workflow 1: Immediate code-first workflow

This is the best option with Evolvo's current capabilities.

1. Gather product requirements.
2. Write a design brief in the repo:
   - audience
   - job to be done
   - reference products
   - constraints
   - tone/brand direction
3. Convert the brief into a build-ready design spec:
   - page map
   - components
   - content blocks
   - states
   - design tokens
   - accessibility requirements
4. Generate a prototype page or small prototype app.
5. Capture screenshots and compare variants.
6. Approve one direction.
7. Refactor the prototype into production-ready components and pages.

Outputs:

- `research/` brief/spec
- prototype code
- screenshots
- review notes

### Workflow 2: External-design-tool workflow

This is the best option when a true visual design tool is required.

1. Gather requirements.
2. Write a design brief.
3. Create wireframes or high-fidelity designs in Figma or Penpot.
4. Add structured annotations:
   - tokens
   - component names
   - responsive rules
   - interaction notes
5. Link design components to code components:
   - Figma Code Connect or an equivalent mapping system
   - Penpot plugin/API-based mapping or artifact export
6. Attach design artifacts to implementation context:
   - frame/file IDs
   - exported screenshots
   - dev resources linking back to GitHub
7. Build page-by-page from the design artifact.
8. Compare coded output back against the design artifact.

Outputs:

- tool-native design artifact
- repository-side design spec
- implementation mapping
- verification screenshots

## 6. How Evolvo would build from the design

### What is easy

- Turning a static design artifact into a component list.
- Extracting tokens such as colors, spacing, typography, radius, and shadows.
- Building a page from a stable layout with named sections.
- Translating repeated UI patterns into reusable components.
- Using story/state-based artifacts to create acceptance checks.

### What is hard

- Inferring product judgment from a pretty screenshot.
- Recovering intent when the design artifact lacks states, breakpoints, or content rules.
- Preserving accessibility when the artifact is mostly visual.
- Translating interaction nuance, motion, and responsive behavior from weak specs.
- Keeping design and implementation synchronized after iteration starts.

### What Evolvo would need as source-of-truth inputs

At minimum:

- one approved screen or component artifact
- design tokens
- component/state inventory
- content hierarchy
- responsive behavior rules
- accessibility expectations

Without those, Evolvo will still code, but it will be guessing.

## 7. Recommended path

### Best immediate path

Adopt a code-first design artifact standard:

- design brief
- build-ready design spec
- static prototype
- screenshots

This is the highest-confidence route because Evolvo can already do it without new infrastructure.

### Best medium-term path

Add Storybook so Evolvo can keep a durable artifact layer for components and pages after the first prototype exists.

This gives:

- reusable design states
- reviewable documentation
- design system growth
- visual regression support

### Best high-fidelity external path

If Evolvo needs real tool-native design creation and handoff, use one of these:

- Figma if the team already lives in Figma and wants the strongest design-review and code-mapping ecosystem.
- Penpot if Evolvo should own more of the automation stack and wants an open, standards-friendly design platform.

### Best quality-control path

Use a hybrid approval loop:

- Evolvo drafts the design artifact.
- A human approves or redirects the visual direction.
- Evolvo implements from the approved artifact.

This is the strongest practical way to avoid "fake design" while still keeping Evolvo productive.

## 8. Limitations and risks

- Evolvo is code-biased. It can mistake polished code output for actual design quality.
- Visual judgment is weaker than engineering judgment.
- Image generation can look persuasive while being unusable as a build artifact.
- Tool-native design workflows add cost, auth, seat, and API dependency risk.
- If design artifacts do not encode states, accessibility, or responsive rules, implementation drift is likely.
- Without explicit versioning between design artifact and code artifact, the system will slowly lose alignment.
- A fully autonomous "design then build" loop is possible only in constrained spaces. In open-ended product work, approval and revision loops still matter.

## Final recommendation

If Evolvo had to start using "real design artifacts" now, the best serious answer is:

1. Treat a coded prototype plus screenshots and a design spec as the first real design artifact Evolvo can produce today.
2. Add Storybook as the long-lived artifact layer for component/page states.
3. If a visual design tool is required, prefer Figma MCP + Code Connect for the mainstream path or Penpot for the open/self-hostable path.
4. Use image generation only to explore direction, never as the final design source of truth.

That gives Evolvo a practical design-to-build loop without pretending that text prompts or pretty screenshots alone are "real design."

## Sources

- Repo evidence:
  - `src/agents/codingAgent.ts`
  - `src/agents/runCodingAgent.ts`
  - `package.json`
- Figma official docs:
  - Figma MCP Server introduction: https://developers.figma.com/docs/figma-mcp-server/
  - Figma MCP plans/access: https://developers.figma.com/docs/figma-mcp-server/plans-access-and-permissions/
  - Figma MCP "what the MCP sends vs. what the agent does": https://developers.figma.com/docs/figma-mcp-server/mcp-vs-agent/
  - Code Connect UI: https://developers.figma.com/docs/code-connect/code-connect-ui-setup/
  - Dev Resources REST API: https://developers.figma.com/docs/rest-api/dev-resources/
  - File/image export endpoints: https://developers.figma.com/docs/rest-api/file-endpoints/
- Penpot official docs:
  - Product overview: https://penpot.app/
  - Dev tools / inspect / code: https://help.penpot.app/user-guide/dev-tools/
  - Flexible layouts and code output: https://help.penpot.app/user-guide/designing/flexible-layouts/
  - Plugin creation: https://help.penpot.app/plugins/create-a-plugin/
- Storybook official docs:
  - Homepage: https://storybook.js.org/
  - Getting started: https://storybook.js.org/docs/
  - Writing stories / CSF: https://storybook.js.org/docs/writing-stories/index
- OpenAI official docs:
  - Image generation guide: https://developers.openai.com/api/docs/guides/image-generation
