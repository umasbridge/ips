# IPS player input contract

`IpsPlayer` displays and, when possible, plays a bridge deal. It does not own
the board result, score, comparison, IMPs/MPs, or team names. The analysis
module must render those separately.

## React API

```jsx
<IpsPlayer
  boardResult={{
    lin,                    // required: deal plus any stored auction/play tags
    contract_level,         // required when LIN cannot derive the contract
    contract_denom,         // C | D | H | S | NT
    contract_x,             // optional: X | XX
    declarer,               // required when LIN has no auction
    lead,                   // optional, e.g. "C6"
    lead_suit,              // optional fallback when lead is not supplied
    lead_rank,              // optional fallback when lead is not supplied
    dealer,                 // optional: N | E | S | W
    vulnerability,          // optional: none | ns | ew | both
    player_n_name,          // optional display label
    player_s_name,
    player_e_name,
    player_w_name,
  }}
  mode="view"              // view | play
  direction="S"            // optional in play mode; defaults to S
  cardingNS="UDCA"         // optional: UDCA | STD; defaults to UDCA
  cardingEW="UDCA"         // optional: UDCA | STD; defaults to UDCA
  format="IMP"             // optional: IMP | MP | null
  autoStart                 // optional; view mode starts automatically
  onComplete={handleDone}   // optional play-mode completion callback
/>
```

## Analysis-owned data

Do not pass these to IPS for display:

- tricks made or overtricks/undertricks;
- raw or formatted score;
- IMP or matchpoint comparison;
- NS/EW participant IDs used for scoring;
- team names or the participant map;
- traveller/comparison annotations.

The analysis module should resolve and render its own result, for example:

```jsx
<div className="board-analysis-result">
  <div>3NT E -5: +500</div>
  <div>+9 IMPs to India</div>
</div>
<IpsPlayer boardResult={ipsDeal} mode="view" />
```

## Play-mode start behavior

- Play uses the same deal layout as View.
- Play uses the former View-arrow area for its controls: `Alert: off/on` on
  the first line, with Undo and Replay aligned beneath it. View-only
  Previous/Next history arrows are omitted.
- If the user controls the opening leader, no card is preplayed.
- Otherwise the known opening lead is the only stored card applied at startup.
- After startup, solver-controlled seats move normally until it is the user's
  turn.

## Vanilla API

`mountIpsPlayer(container, options)` accepts the normalized `row` described in
`AGENTS.md`, plus player options. `resultHtml` is not supported. A host that
needs an analysis result must render it outside the IPS mount.
