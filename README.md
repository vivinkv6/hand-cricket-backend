# Hand Cricket Server

This server powers the realtime game logic for Hand Cricket. It controls the match rules, keeps all players in sync, and preserves match progress and replay history.

## What The Server Handles

- Room creation and room join flow
- Realtime multiplayer match updates
- Toss and innings flow
- Ball-by-ball match resolution
- Team and captain-based match control
- Spectator support
- Reconnect support for returning players
- Replay and saved match history

## Game Modes Supported

- `Solo`
  - One human player against a bot
- `1v1`
  - One player on each side
- `Teams`
  - Multiplayer team rooms from `2v2` to `5v5`

## How The Game Is Controlled

- The server is the source of truth for the match
- Players send actions such as starting the game, choosing toss decisions, selecting bowlers, and playing numbers
- The server validates those actions before applying them
- Every delivery is resolved on the server so all players see the same result
- The latest room state is then shared back to connected players and spectators

## Match Flow Supported

- Room setup before the match
- Team balancing and captain assignment
- Toss to decide batting or bowling first
- Live innings with batter and bowler selections
- Wicket handling when numbers match
- Run scoring when numbers differ
- End-of-innings switch
- Chase completion or all-out finish
- Match result and rematch flow

## What Has Been Built In The Server

- Authoritative multiplayer game flow
- Support for solo, duel, and team matches
- Live room state tracking
- Spectator presence tracking
- Rejoin handling for disconnected or refreshed players
- Match replay support
- Match history persistence
- Protection against duplicate actions during live play
- Recovery support for ongoing rooms
- Cleanup of stale rooms after inactivity

## Persistence In Simple Terms

- Live rooms are kept fast and responsive during play
- Match progress is preserved so rooms can recover
- Ball-by-ball history is saved for replay after the match

## Overall Goal Of This Backend

The backend is designed to make the game feel fair, consistent, and realtime. It keeps the match logic centralized so every player sees the same state, the same score, and the same result.
