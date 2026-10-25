# Public TypeUI foundation audit

Observed 2026-10-20. Every example below was opened and its public About explanation inspected. This records design decisions, not a claim of full paid-export compliance or exhaustive device verification. TypeUI often shows the bad case first; its bad-case values were not copied as recommendations.

The paid rule export redirected to a subscription page. No paywall bypass, purchase, package acquisition or proprietary source extraction was performed.

Paths below are relative to phone miniapp/web/src/ or native Hey-Aside/Sources/. Retained means preserve the existing applicable pattern, not that every surface/state has been measured. Conditional means the technique is used only where the product has that interaction, not added for its own sake.

## Typography & readability

Phone: theme/tokens.css, base.css, components/Markdown.tsx. Jarvis: IslandGlance.swift GK, Island.swift caption fonts. Retain role-based scale and resident font shaping; do not restyle glyph outlines.

| Public example | Decision |
| --- | --- |
| [Type scale](https://www.typeui.sh/ui-foundations/configurator?category=text&example=type-scale) | Retain applicable existing pattern |
| [Readable fonts](https://www.typeui.sh/ui-foundations/configurator?category=text&example=good-fonts) | Retain applicable existing pattern |
| [Font smoothing](https://www.typeui.sh/ui-foundations/configurator?category=text&example=font-smoothing) | Conditional / platform or content dependent |
| [Baselines](https://www.typeui.sh/ui-foundations/configurator?category=text&example=text-baseline) | Retain applicable existing pattern |
| [Line height](https://www.typeui.sh/ui-foundations/configurator?category=text&example=leading) | Retain applicable existing pattern |
| [Descriptive links](https://www.typeui.sh/ui-foundations/configurator?category=text&example=quiet-links) | Retain applicable existing pattern |
| [Text alignment](https://www.typeui.sh/ui-foundations/configurator?category=text&example=readable-alignment) | Retain applicable existing pattern |
| [Letter spacing](https://www.typeui.sh/ui-foundations/configurator?category=text&example=tracking) | Retain applicable existing pattern |
| [Obvious links](https://www.typeui.sh/ui-foundations/configurator?category=text&example=recognizable-links) | Corrected in this pass |
| [Clear characters](https://www.typeui.sh/ui-foundations/configurator?category=text&example=clear-characters) | Retain applicable existing pattern |
| [Contextual punctuation](https://www.typeui.sh/ui-foundations/configurator?category=text&example=contextual-punctuation) | Conditional / platform or content dependent |

## Text wrapping

Phone: theme/system.css section 13, Markdown.tsx streaming renderer. Jarvis: Island.swift caption line limits. Pretty-wrap bounded descriptions only; never balance growing stream text.

| Public example | Decision |
| --- | --- |
| [Headings](https://www.typeui.sh/ui-foundations/configurator?category=text-wrap&example=heading) | Retain applicable existing pattern |
| [Descriptions](https://www.typeui.sh/ui-foundations/configurator?category=text-wrap&example=description) | Corrected in this pass |
| [Long links](https://www.typeui.sh/ui-foundations/configurator?category=text-wrap&example=link) | Corrected in this pass |

## Reading width

Phone: Thread.tsx + theme/components.css .thread/.md. Jarvis: bounded Glance.width and Deck width. Preserve existing reading columns rather than impose a tiny universal measure.

| Public example | Decision |
| --- | --- |
| [Line length](https://www.typeui.sh/ui-foundations/configurator?category=line-length&example=line-length) | Retain applicable existing pattern |

## Data alignment

Phone: theme/system.css numeric metadata and existing markdown column alignment. Jarvis: GK.number, WorkSheet timer. Keep numeric metrics stable; arbitrary generated-table alignment is not exhaustively certified.

| Public example | Decision |
| --- | --- |
| [Tabular numbers](https://www.typeui.sh/ui-foundations/configurator?category=tabular-numbers&example=tabular-numbers) | Corrected in this pass |
| [Typographic alignment](https://www.typeui.sh/ui-foundations/configurator?category=tabular-numbers&example=table-alignment) | Retain applicable existing pattern |

## Spacing & sizing

Phone: theme/system.css, Composer.tsx, SettingsScreen.tsx. Jarvis: GlanceView margin/section/inset and fixed island geometry. Preserve the inherited spacing system, fluid field width and grouped sections.

| Public example | Decision |
| --- | --- |
| [Breathing room](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Input width](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=content-width) | Retain applicable existing pattern |
| [Content-sized](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=flexible-grid) | Retain applicable existing pattern |
| [Scale by role](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=independent-sizes) | Retain applicable existing pattern |
| [Clear groups](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=proximity) | Retain applicable existing pattern |
| [Section separators](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=weight-contrast) | Retain applicable existing pattern |

## Visual hierarchy

Phone: SettingsScreen.tsx, QuestionCard.tsx, Composer.tsx. Jarvis: GK title/body/caption and ApprovalSheet. Keep primary actions distinct; expose selected setting semantics.

| Public example | Decision |
| --- | --- |
| [Importance](https://www.typeui.sh/ui-foundations/configurator?category=hierarchy&example=importance) | Retain applicable existing pattern |
| [Beyond size](https://www.typeui.sh/ui-foundations/configurator?category=hierarchy&example=weight-not-size) | Retain applicable existing pattern |
| [Action focus](https://www.typeui.sh/ui-foundations/configurator?category=hierarchy&example=de-emphasize) | Corrected in this pass |
| [Labels & data](https://www.typeui.sh/ui-foundations/configurator?category=hierarchy&example=data-labels) | Retain applicable existing pattern |
| [Heading roles](https://www.typeui.sh/ui-foundations/configurator?category=hierarchy&example=semantic-heading) | Retain applicable existing pattern |
| [Action priority](https://www.typeui.sh/ui-foundations/configurator?category=hierarchy&example=action-hierarchy) | Retain applicable existing pattern |

## Optical balance

Phone: existing icon slots and shared control geometry. Jarvis: Hero optical offsets and fixed icon slots. Let system fonts own overshoot; do not nudge every string or animate weight.

| Public example | Decision |
| --- | --- |
| [Button padding](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=button-padding) | Retain applicable existing pattern |
| [Icon balance](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=play-icon) | Retain applicable existing pattern |
| [Icon area](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=icon-area) | Retain applicable existing pattern |
| [Color weight](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=color-weight) | Retain applicable existing pattern |
| [Glyph overshoot](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=glyph-overshoot) | Conditional / platform or content dependent |
| [Case scale](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=case-scale) | Retain applicable existing pattern |
| [Button label](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=button-label) | Retain applicable existing pattern |
| [Letter alignment](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=headline) | Retain applicable existing pattern |
| [Hanging marks](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=hanging-punctuation) | Conditional / platform or content dependent |
| [Weight colour](https://www.typeui.sh/ui-foundations/configurator?category=optical-alignment&example=text-weight-color) | Retain applicable existing pattern |

## Color systems

Phone: theme/tokens.css and inherited Paper/Midnight. Jarvis: JarvisGlass.swift JG and GK semantic colors. Keep neutral chrome, inherited accent and redundant glyph/text status cues.

| Public example | Decision |
| --- | --- |
| [Palette roles](https://www.typeui.sh/ui-foundations/configurator?category=color&example=palette-roles) | Retain applicable existing pattern |
| [Shade scale](https://www.typeui.sh/ui-foundations/configurator?category=color&example=shade-scale) | Retain applicable existing pattern |
| [Rich tints](https://www.typeui.sh/ui-foundations/configurator?category=color&example=saturation) | Conditional / platform or content dependent |
| [Visual distinction](https://www.typeui.sh/ui-foundations/configurator?category=color&example=color-signals) | Retain applicable existing pattern |

## Color contrast

Phone: tokens, question foreground roles and section-13 focus outline. Jarvis: JG contrast/transparency policy. Focus is checked in normal browser mode; not every image, backdrop, generated card or forced-colors runtime is certified.

| Public example | Decision |
| --- | --- |
| [Input contrast](https://www.typeui.sh/ui-foundations/configurator?category=input-contrast&example=input-contrast) | Retain applicable existing pattern |
| [Text contrast](https://www.typeui.sh/ui-foundations/configurator?category=input-contrast&example=text-contrast) | Retain applicable existing pattern |
| [Button contrast](https://www.typeui.sh/ui-foundations/configurator?category=input-contrast&example=button-contrast) | Retain applicable existing pattern |
| [Text on color](https://www.typeui.sh/ui-foundations/configurator?category=input-contrast&example=tinted-text) | Retain applicable existing pattern |
| [Readable color](https://www.typeui.sh/ui-foundations/configurator?category=input-contrast&example=accessible-color) | Retain applicable existing pattern |
| [Text over images](https://www.typeui.sh/ui-foundations/configurator?category=input-contrast&example=image-contrast) | Conditional / platform or content dependent |

## Forms & selection

Phone: SettingsScreen.tsx label rows/aria-pressed, QuestionCard.tsx complete-row choices and custom input, ModelSheet.tsx search. Jarvis: native labelled buttons. Keep all submit/default/approval handlers unchanged.

| Public example | Decision |
| --- | --- |
| [Clickable labels](https://www.typeui.sh/ui-foundations/configurator?category=forms&example=clickable-labels) | Corrected in this pass |
| [Label selection](https://www.typeui.sh/ui-foundations/configurator?category=forms&example=label-selection) | Corrected in this pass |
| [Recognizable buttons](https://www.typeui.sh/ui-foundations/configurator?category=forms&example=recognizable-buttons) | Retain applicable existing pattern |
| [Wrapped labels](https://www.typeui.sh/ui-foundations/configurator?category=forms&example=multiline-checkbox) | Retain applicable existing pattern |
| [Search over scrolling](https://www.typeui.sh/ui-foundations/configurator?category=forms&example=searchable-select) | Retain applicable existing pattern |
| [One-column choices](https://www.typeui.sh/ui-foundations/configurator?category=forms&example=checkbox-column) | Retain applicable existing pattern |
| [Value clarity](https://www.typeui.sh/ui-foundations/configurator?category=forms&example=slider-value) | Conditional / platform or content dependent |
| [Comparable options](https://www.typeui.sh/ui-foundations/configurator?category=forms&example=outside-box) | Conditional / platform or content dependent |

## Control alignment

Phone: section-13 matched question actions and existing composer controls. Jarvis: shared button styles and stable status slots. Retain density on desktop; grow phone hit targets only.

| Public example | Decision |
| --- | --- |
| [Search](https://www.typeui.sh/ui-foundations/configurator?category=control-heights&example=search) | Retain applicable existing pattern |
| [Pagination](https://www.typeui.sh/ui-foundations/configurator?category=control-heights&example=pagination) | Conditional / platform or content dependent |
| [Action toolbar](https://www.typeui.sh/ui-foundations/configurator?category=control-heights&example=action-bar) | Corrected in this pass |

## Touch & pointer targets

Phone: section-13 actual targets, existing Sheet/SwipeToDelete/VoiceButton. Jarvis: retain native pointer targets rather than force phone dimensions. Measured changed question/mode/setting targets; do not claim every app control was geometry-tested.

| Public example | Decision |
| --- | --- |
| [Icon targets](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=toolbar) | Corrected in this pass |
| [Button targets](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=dismiss) | Corrected in this pass |
| [Target spacing](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=pages) | Retain applicable existing pattern |
| [Target coverage](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=target-bounds) | Corrected in this pass |
| [Close buttons](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=modal-close) | Retain applicable existing pattern |
| [Room to swipe](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=swipe-room) | Conditional / platform or content dependent |
| [Touch visibility](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=unobscured-result) | Conditional / platform or content dependent |
| [Edge navigation](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=carousel-edges) | Conditional / platform or content dependent |
| [Room to click](https://www.typeui.sh/ui-foundations/configurator?category=target-size&example=room-to-click) | Retain applicable existing pattern |

## Keyboard focus

Phone: section-13 :focus-visible and whole-label input outline. Jarvis: native button focus. Browser normal-focus geometry checked; OS forced-colors emulation unavailable in Asidewright.

| Public example | Decision |
| --- | --- |
| [Focus visibility](https://www.typeui.sh/ui-foundations/configurator?category=focus-visible&example=focus-visible) | Corrected in this pass |

## Status communication

Phone: existing status text, progress and glyphs; settings aria-pressed. Jarvis: state labels plus symbols, not color alone. Do not invent work steps or progress.

| Public example | Decision |
| --- | --- |
| [Status signals](https://www.typeui.sh/ui-foundations/configurator?category=status-signal&example=status-signal) | Retain applicable existing pattern |

## Press feedback

Phone: existing .97 press family and stable mode-label weight/opacity. Jarvis: AK.press/state. Preserve no-overshoot default; no delayed action or large button squash.

| Public example | Decision |
| --- | --- |
| [Action feedback](https://www.typeui.sh/ui-foundations/configurator?category=press-feedback&example=button) | Retain applicable existing pattern |
| [Toggle feedback](https://www.typeui.sh/ui-foundations/configurator?category=press-feedback&example=bookmark) | Retain applicable existing pattern |
| [Selection feedback](https://www.typeui.sh/ui-foundations/configurator?category=press-feedback&example=chip) | Corrected in this pass |

## Interruptible transitions

Phone: existing Sheet.tsx/useAnimatedClose/Collapse lifecycle and regression tests. Jarvis: IslandMotion current-velocity retargeting. Keep input available during transitions.

| Public example | Decision |
| --- | --- |
| [Sidebar](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Bottom sheet](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Popover](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |

## Animation principles

Phone: existing motion library and fixed-slot status updates. Jarvis: IslandTranscript, WorkSheet local completion and quiet timer. These are conditional techniques, not instructions to add carts, flips or animation everywhere.

| Public example | Decision |
| --- | --- |
| [Squash & stretch](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Anticipation](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Clear motion paths](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Follow through & overlap](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Slow in & slow out](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Arcs](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Conditional / platform or content dependent |
| [Feedback without distraction](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Corrected in this pass |
| [Timing](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Noticeable errors](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Readable flips](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Conditional / platform or content dependent |
| [Consistent feedback](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Corrected in this pass |

## Interaction details

Phone: existing pointer capture in Sheet/SwipeToDelete/SlideToConfirm and voice hold. Jarvis: existing interruptible geometry. Gesture logic/security thresholds are unchanged; keyboard mode selection settles instantly.

| Public example | Decision |
| --- | --- |
| [Responsive gesture](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Cancelable gesture](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Continuous gesture](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Responsive feedback](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Corrected in this pass |

## Nested corners

Phone: 52px mode shell/4px inset/44px thumb with 26px/22px radii, existing card/composer radii. Jarvis: existing shared glass mask and inset geometry. Apply outer-minus-inset where geometrically applicable.

| Public example | Decision |
| --- | --- |
| [Card + inset image](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Input + inset button](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Dropdown + inset header](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Navigation + inset highlight](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Alert + inset badge](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Tabs + inset selection](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Corrected in this pass |

## Layering & elevation

Phone: inherited raised sheets, scrims, toasts and opaque reading surfaces. Jarvis: native shared glass shell. No new per-row blur, extra shadow layers or depth gimmicks.

| Public example | Decision |
| --- | --- |
| [Base surface](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Dropdown layer](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Raised card](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Floating notification](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Modal depth](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |

## Image quality & framing

Phone: existing Markdown image renderer and AttachmentsTray fixed aspect frames. Jarvis: existing bounded asset/icon sizes. No image is resized, replaced or compressed by this pass.

| Public example | Decision |
| --- | --- |
| [Photo quality](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Conditional / platform or content dependent |
| [Intended size](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Consistent frames](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Image outline](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Conditional / platform or content dependent |

## Task & layout clarity

Phone: retain task-first composer and one history scroller. Jarvis: retain glance/Deck hierarchy. No navigation redesign, decorative background addition or new feature.

| Public example | Decision |
| --- | --- |
| [Feature first](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Structure first](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |

## Design consistency

Phone: existing named actions + shared section-13 corrections. Jarvis: same shared AK/GK/JG vocabulary. Keep identity, source of truth and action locations stable.

| Public example | Decision |
| --- | --- |
| [Action placement](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Corrected in this pass |
| [Consistent names](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Personality](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Shared styles](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |

## Component details

Phone: existing actionable empty/error copy, semantic symbols and grouped hairlines. Jarvis: existing triage/notice/approval semantics. Quiet backgrounds and limited accents do not require decorative side stripes.

| Public example | Decision |
| --- | --- |
| [Meaningful list icons](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Conditional / platform or content dependent |
| [Accent borders](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Conditional / platform or content dependent |
| [Quiet backgrounds](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Empty states](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |
| [Fewer borders](https://www.typeui.sh/ui-foundations/configurator?category=layout&example=white-space) | Retain applicable existing pattern |

## Verification limits

- Phone: final regression/type/build results and measured fixture geometry are recorded in typeui-foundations.md; no real paired-device or real-voice test was run.
- Native: updated source compiles and is reviewed; new-binary execution is blocked before main with macOS quarantine metadata present. Existing installed baseline had 335 green unit checks. New checks and updated native renders remain unverified until execution is authorized.
- Existing slide-to-confirm commit thresholds, native approval parsing/default-deny behavior, authentication, routing, storage and real tasks are intentionally unchanged.
- Arcs, flips, decorative icons, saturated tints, added side stripes and image overlays are not universal requirements and were not introduced where absent.
