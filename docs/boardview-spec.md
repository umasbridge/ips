# BoardView (src/BoardView.jsx) — to build

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
