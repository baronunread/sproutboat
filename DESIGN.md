---
name: Sproutboat
description: A dark control-room interface for locally built, immutable VPS deployments.
colors:
  ink: "#0b1014"
  panel: "#121a20"
  panel-2: "#18232b"
  line: "#2b3b45"
  text: "#f1f7f3"
  muted: "#a6b6b6"
  lime: "#c8ff5a"
  sky: "#66d6ff"
  coral: "#ff8b73"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3.5rem, 8vw, 7rem)"
    fontWeight: 400
    lineHeight: 0.87
    letterSpacing: "-0.065em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(1.55rem, 3vw, 2.6rem)"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.045em"
  body:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8rem"
    fontWeight: 700
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.8rem"
rounded:
  full: "50%"
spacing:
  compact: "0.65rem"
  control: "1rem"
  panel: "1.6rem"
  section: "2.2rem"
  page: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.lime}"
    textColor: "#111"
    padding: "0 1rem"
    height: "2.9rem"
  button-primary-hover:
    backgroundColor: "#dcff95"
    textColor: "#111"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    padding: "0 1rem"
    height: "2.9rem"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    padding: "1.6rem"
---

# Design System: Sproutboat

## Overview

**Creative North Star: "The Artifact Control Room"**

Sproutboat is a deliberate, code-first dark interface for a developer VPS POC. It treats compilation, identity, routing, and runtime state as operational records rather than lifestyle branding: the landing page pairs a direct deployment statement with a tangible manifest, while the dashboard organizes quiet empty-state evidence around a first deployment.

The visual field is midnight-dark and structurally lined. Lime is the scarce affirmative signal for action, health, and command prompts; sky is the routing and telemetry signal. A warm paper manifest is the intentional exception: it makes the immutable artifact legible as a receipt. The system stays practical and direct, matching the product’s local Linux/amd64 build-to-isolated-VPS-runtime workflow.

**Key Characteristics:**

- Dark, grid-like control-room surfaces with thin structural rules.
- One high-contrast action/status color and one cool routing/telemetry color.
- Large compressed headlines; compact metadata and code use mono.
- Truthful zero-state panels that explain the next CLI action.

## Colors

The palette assigns color to operational meaning, keeping the dark field and high-contrast signals readable rather than decorative.

### Primary

- **Artifact Lime**: primary confirmation, primary buttons, focused controls, active navigation rails, status dots, and command prompts.

### Secondary

- **Routing Sky**: emphasized hero phrase, flow numbers, route placeholders, telemetry marks, and successful CLI output.

### Tertiary

- **Failure Coral**: form-error text.

### Neutral

- **Midnight Ink**: the page background and terminal-like code surface.
- **Control Panel**: the default dark panel fill, including nav hover and empty-chart copy backing.
- **Raised Panel**: the artifact section and avatar fill.
- **Structural Line**: one-pixel dividers, panel boundaries, field strokes, and chart baselines.
- **Paper Text**: the main foreground color on dark surfaces.
- **Muted Metadata**: explanatory body copy, labels, and secondary operational detail.

**The Signal-Only Rule.** Reserve Artifact Lime for committed action, active state, focus, and positive operational status. Use Routing Sky for route and telemetry information; neither color becomes a general panel fill.

## Typography

**Display Font:** ui-sans-serif, system-ui, sans-serif

**Body Font:** ui-sans-serif, system-ui, sans-serif

**Label/Mono Font:** ui-monospace, SFMono-Regular, monospace

**Character:** System sans keeps the product native to a developer machine. Tight, oversized sans headlines make the landing claim and workspace orientation immediate, while mono marks artifacts, routes, commands, and values as inspectable records.

### Hierarchy

- **Display** (400, `clamp(3.5rem, 8vw, 7rem)`, 0.87): landing hero statement; the dashboard uses a smaller display range for its overview heading.
- **Headline** (700, `clamp(1.55rem, 3vw, 2.6rem)`, 1): section, panel, and onboarding-guide headings.
- **Body** (400, 1rem, 1.6): explanations constrained to approximately 34–38rem where used.
- **Label** (700, 0.8rem): form labels and compact UI metadata.
- **Mono** (400, 0.8rem): manifest values, CLI commands, route identifiers, and step numbers.

**The Record Rule.** Use mono for data a developer may copy, inspect, or compare; do not use it to set narrative body copy.

## Layout

Landing content centers in a 1280px container with 3rem desktop gutters. The hero is a 1.1fr/0.9fr two-column split with a 5rem gap and viewport-height presence; the manifest sits as its physical proof object. The how-it-works section changes the structure to a 0.8fr/1.2fr editorial grid, and the artifact section becomes a padded, raised field.

The dashboard uses a 14rem persistent sidebar, a 4rem topbar, and a 1300px main content container with 3rem desktop gutters. Metrics occupy four equal columns, then activity and the deployment guide split 1.2fr/0.8fr. At 800px, landing and dashboard structural grids become one column, the sidebar becomes a horizontal scrolling navigation strip, metrics become two columns, and the manifest loses its rotation. At 480px, metrics and primary action groups become single-column and buttons span their container.

**The Ledger Rhythm Rule.** Use thin lines, broad section gaps, and consistent panel padding to separate operational records. Do not replace the system’s divisions with soft, floating-card spacing.

## Elevation & Depth

Sproutboat is flat by default. Depth comes from the midnight base, two darker panel tones, one-pixel rules, and bounded code surfaces rather than ambient shadow. The landing manifest is the only deliberately physical object: it is paper-colored, rotated, and given a hard offset shadow to read as a deployment receipt.

### Shadow Vocabulary

- **Manifest Offset** (`15px 16px 0 #0a0e10`): exclusive to the landing deployment manifest.
- **Active Navigation Rail** (`inset 2px 0 Artifact Lime`): marks the current dashboard location.
- **Artifact Terminal Edge** (`inset 0 3px Artifact Lime`): gives the CLI output its successful, executable state.

**The Receipt Exception Rule.** Keep operational panels flat; only the manifest may use an offset physical shadow and rotation.

## Shapes

The form language is square, bordered, and utilitarian. Buttons, panels, fields, badges, command surfaces, and manifest content use no declared corner radius. The avatar and status dot are circular functional markers. Borders are consistently one pixel and use the structural-line color on dark surfaces.

## Components

### Buttons

Buttons are compact action bars with an icon gap, one-pixel structural border, and a 150ms upward hover response.

- **Shape:** square-edged, no declared radius; minimum height 2.9rem.
- **Primary:** Artifact Lime fill and border with near-black text, bold weight, and 1rem horizontal padding.
- **Hover / Focus:** primary fill lightens; all buttons translate upward 2px on hover. Keyboard focus receives a 3px Artifact Lime outline with 3px offset.
- **Quiet:** transparent fill, Paper Text, and the same structural border and dimensions.
- **Disabled:** 45% opacity, no transform, and not-allowed cursor.

### Cards / Containers

Operational panels use a Control Panel or transparent dark field, a one-pixel Structural Line border, square edges, and 1.6rem internal padding. The namespace and connection panels use a larger 2rem padding; the raised artifact block uses responsive 2–6rem padding. Metric cells are not individually floating cards: their boundaries are the shared grid rules.

### Inputs / Fields

Text fields use Midnight Ink fill, a one-pixel Structural Line border, Paper Text, and 0.75rem padding. Field labels are bold compact sans text. There is no custom focus fill; the shared global focus outline supplies the visible keyboard state.

### Navigation

Landing navigation is a 5.5rem rule-bottom bar: a lime square `P` wordmark anchors the left and muted text links brighten on hover. Dashboard navigation is a muted vertical list with 0.75rem horizontal padding; hover and active states fill Control Panel, with active state adding the lime inset rail. On smaller screens it becomes a horizontally scrollable row.

### Deployment Manifest

The landing manifest is a warm paper ledger with 1.25rem padding, compact uppercase headers, internal horizontal rules, monospace metadata, a dark route-method chip, a 2° desktop rotation, and its hard offset shadow. It represents the local-build artifact and must remain distinct from dashboard panels.

### Empty Operational Panels

Metrics, activity, routes, and first-deployment guidance use concrete zero values, explanatory copy, and next CLI commands rather than fabricated charts or activity. The empty activity panel keeps a restrained sky/lime signal trace behind its explanatory label.

## Do's and Don'ts

### Do:

- **Do** use Artifact Lime for primary actions, active/healthy state, focus, and command success.
- **Do** use Routing Sky for route, flow, and telemetry signals.
- **Do** pair a direct deployment claim with artifact-specific evidence such as a manifest, command, route, or immutable identity.
- **Do** make empty states operational: show the honest zero state and the next CLI action.
- **Do** preserve square structural panels, one-pixel rules, and system-plus-mono typography.

### Don't:

- **Don't** turn the dashboard into a generic rounded-card SaaS surface.
- **Don't** use lime or sky as broad decorative backgrounds; they are reserved signals.
- **Don't** invent traffic, projects, deployments, or success metrics before the user has deployed.
- **Don't** apply the landing manifest’s paper treatment, rotation, or hard shadow to normal control-room panels.
