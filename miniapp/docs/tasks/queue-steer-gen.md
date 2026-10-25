# Desktop-style queue + Send now, and the visual generation build

## Outcome contract
- Mid-turn, empty composer: the primary slot is Stop. Any text: it becomes Send (queue). Cleared: Stop again.
- Sending mid-turn shows a card above the composer (words, Send now, Edit, Remove), like Aside on the Mac.
- When the turn ends, waiting messages run (adjacent ones batch into one turn, reminder appended once).
- Send now = `aside session steer <id> -- <prompt>` (CLI 1.26.1014). Refused steer puts the message back first in line.
- Edit = remove from queue, words back in the box. Remove = gone. Stop drops the queue and hands the words back.
- A message sent while a Mac-owned turn runs is held until the daemon status leaves `running` (max 30 min), instead of resuming a busy session.
- A `visual` block that arrives live plays the transitions.dev skeleton build once per device; history never does.

## Invariants
- The runner queue (server memory) is the source of truth; the client only adds optimistic cards until acknowledged.
- No route returns 502/530 (front-door rule). Failed queue actions never lose typed text.
- Visual pages composed without the build are byte-identical to before.

## Verification
- server: `test/queue-steer.test.ts` + full suite (1369/1369 with test-only OPENSSL_CONF).
- web: `test/queue-composer.test.tsx`, `test/visual-generation.test.ts` + full suite (733/733).
- Visual: chat-lab `?state=queue` (light/dark), generation frames captured from a composed page.

## Not verified here
- `aside session steer` against a live turn: the agent sandbox has no keychain access to run the CLI. First real Send now is the live test.
