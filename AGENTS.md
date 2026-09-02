# IPS Repo

Self-contained bridge play engine and UI components. No runtime dependencies beyond React (peer dep).

## Structure

```
index.js          — package entry
src/
  ips.js          — naturalness rules (bpIps global)
  ips-module.js   — vanilla JS play table: mountIpsPlayer(container, options)
  IpsPlayer.jsx   — React wrapper around mountIpsPlayer
```

## Runtime globals (loaded by host before mountIpsPlayer)

```
globalThis.bpLin    — LIN parser (lin.js)
globalThis.bpPlay   — game engine (play.js)
globalThis.bpIps    — naturalness rules (ips.js)
```

## mountIpsPlayer API

```js
const player = mountIpsPlayer(containerEl, {
  row: {
    lin,                    // LIN string from DB (mb| auction + pc| play sequence)
    play,                   // string[] of played cards e.g. ['DT','D2',...] — extracted
                            // from pc| tokens; deduplicate BBO double-lead quirk first
    problem_visible_hands,  // e.g. ['S'] play mode, ['N','S','E','W'] view mode
    contract,               // e.g. '4H' (optional, for alert/claim logic)
    player_names,           // { N, S, E, W } (optional)
    dealer,                 // 'N'|'E'|'S'|'W' (optional, for compass)
    vul,                    // 'none'|'ns'|'ew'|'both' (optional, for compass)
  },
  mode,        // 'play' (default) | 'view' — view hides play_nav (undo/claim/alert)
  ddsPath,     // URL to dds-api.js
  cardingNS,   // 'UDCA' | 'STD'
  cardingEW,   // 'UDCA' | 'STD'
  format,      // 'MP' | 'IMP' | null
  onComplete,  // fn({ interactive, gaveUp, solved, tricksMade, optimal, retries, timestamp })
  navEl,       // external DOM element for play_nav controls
});

player.unmount();
player.finalizeIfInteracted();
```

## Modes

- **play**: user plays one seat. `navEl` shows `play_nav` (undo ⎌, claim, alert, replay).
- **view**: all 4 hands visible, steps through recorded play. No `play_nav`. Inline `view_nav` (◀▶) appears at trick boundaries — ◀ rewinds full game state one trick back via `trickCheckpoints`.

## LIN normalization

DB LINs have uppercase `mb|P|` passes. Normalize before passing:
```js
lin.replace(/mb\|P\|/g, 'mb|p|')
```

BBO LINs sometimes duplicate the opening lead (`pc|DT|pc|DT|`). Strip with:
```js
if (cards[0] === cards[1]) cards.shift()
```

## IpsPlayer.jsx

React wrapper around `mountIpsPlayer`. Props: `lin`, `direction`, `cardingNS`, `cardingEW`, `format`, `onComplete`, `autoStart`.

## BoardView (src/BoardView.jsx) — to build

```jsx
<BoardView
  board={board}             // { board_number, dealer, vulnerability, dd_n_s, ... }
  result={result}           // { contract_level, contract_denom, contract_x, declarer,
                            //   lead_suit, lead_rank, score, overtricks,
                            //   mp_ns, mp_ew, imps_ns, imps_ew, lin }
  direction="S"
  cardingNS="UDCA"
  cardingEW="UDCA"
  format={null}
  participantMap={{}}
  ourParticipantId={null}
  isTeams={false}
  boardNumber={null}
  onTraveller={fn}
  onNotes={fn}
  notesLoading={false}
  notesUnread={0}
  onOpenReplay={fn}
  onBoardComplete={fn}
/>
```

Left panel: board number, dealer, vul, bidding table, contract + result + score. Right panel: IpsPlayer.
