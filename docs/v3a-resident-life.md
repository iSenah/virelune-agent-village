# V3A: resident life and task state

Each permanent resident has **one** character in the village, and it moves only because of real activity recorded by Village Hall. The village never invents work, never shows fake progress, and never makes provider calls to cause an animation.

## How it fits together

```
real events (run.*, approval.*)  ──►  ActivityTracker (server/lib/activity.ts)
                                           │  /api/state → activity
                                           ▼
                                      LifeDirector + ResidentLife (web/src/village/life.ts, pure TypeScript)
                                           │  where each character is, what state it is in
                                           ▼
                                      scene.ts + lifeVisuals.ts (characters, indicators, Zzz, badges)
```

- **Village Hall's activity record** (`server/lib/activity.ts`) holds, for each resident:
  - its active runs (kind, task id, profile, workplace, start time, real progress if any);
  - its pending approvals;
  - its last outcome.

  It is built from events appended **since startup** and served in `/api/state` as `activity`, with the server's clock.
- **Visual state is separate from task state.** The task engine and the run events stay the source of truth. The browser only decides how a character gets somewhere and how it looks on the way.

## Event contract

| Event | Fields used |
| --- | --- |
| `run.started` | actor (resident or execution profile), `runId`, `taskId?`, payload `kind`, optional `profile` / `workplace` |
| `run.progress` | `runId`, payload `done`, `total`, `label?`. Accepted only if `0 ≤ done ≤ total` and `total > 0`; anything else is ignored. |
| `run.finished` / `run.failed` / `run.interrupted` | `runId` → outcome completed / failed / stopped |
| `approval.requested` | actor, `taskId?`, payload `approvalId`, `runId?` (now added automatically from the approval's detail) |
| `approval.decided` | payload `approvalId` |

Today the only real runs are **chat replies**. The task engine still never starts tasks, because no task runner exists yet. When one is added, it only has to emit these events, with the profile as actor, and characters will walk to the right workplace.

## One resident, several profiles

- A profile always resolves to its resident and its workplace:
  - `codex-unreal` → Codex at UE Studio;
  - `claude-blender` → Claude at Blender House.
- Work without a profile happens at home: a chat reply means Claude works in the Library, and Codex in the Engineering Forge.
- Tasks can be assigned to a profile in the task form ("Codex · Unreal (at UE Studio)").
- However many runs or profiles are busy, there is one character. `/api/state` lists activity per resident, never per profile.

## Destination rule

1. **Pending approvals:** the oldest one wins. The character stands outside that workplace's door.
2. **Otherwise active runs:** the earliest-started one wins (ties go to the lower run id). The character works inside that workplace.
3. **Otherwise home.**

Queued, ready or blocked tasks never move a character. Every real run is still kept and shown in the indicators. The character simply goes where the rule says.

## States

`idle_home` → `waking` → `traveling_to_work` → `working` (inside, not drawn) ⇄ `awaiting_approval` (at the door) → `task_completed` / `task_failed` (badge at the door for 2.5 s) → `returning_home` → `idle_home`.

- Work at home skips the trip: waking, then working.
- Characters walk only along the layout's roads (`config/layout/world.json`). They cross the river on the arched bridge decks, climb the stairs to Scholars' Heights and take the dirt road to the Woods. Tests check that no route crosses the river away from a bridge or passes through a building.

## Recovery

| Situation | What happens |
| --- | --- |
| Page reload | Characters are placed where the activity record says, without walking there. An outcome from before the reload is not acted out again. |
| Village Hall restart | The activity record starts empty. Runs in flight were already marked interrupted, and nothing old is shown as happening now. |
| Work finishes or fails while walking | The badge shows where the character stands. It then turns back along the roads, to the last crossing passed and then home, never cutting across. |
| Destination changes while walking | The character reroutes along the roads in the same way. |
| Run stopped by you | No badge, no red indicator; the character goes home. |
| Provider disconnects | The run ends with a failed or interrupted event and is handled as above. Zzz only shows for connected residents. |
| Model missing or not loaded | The procedural stand-in walks the same routes. Movement does not depend on the model. |
| Several runs for one resident | All are kept and counted; the character follows the destination rule. |
| Approval answered after the run ended | Ending a run clears its unanswered approvals from the picture. |

## Indicators above buildings

- **Blue** means a real run is active there, **amber** waiting for your approval, **red** failed, and **gold** completed.
- Amber outranks blue. Red and gold show only when nothing is active there, and only for 3 minutes after the outcome by Village Hall's clock. A stopped run shows nothing.
- With no progress data the ring just spins (indeterminate). An arc of exactly `done/total` is drawn only when the provider sent real numbers for a single run. Several runs at one building stay indeterminate; there are no combined percentages.
- Each indicator records the run, approval and task ids behind it.
- Chimney smoke and the forge gear now follow blue indicators, so they also come from the activity record.

## Idle

- Connected residents with nothing to do rest at their door with floating Zzz.
- Unconnected residents stand dimmed, with no Zzz.
- **Graphics → Show resting Zzz** turns it off.
- Planned residents (Gemini, Copilot, DeepSeek) have no character and never show activity.

## Simulation mode (development only)

- **How to open it:** add `?simulate` to the village URL. A striped "SIMULATION · not real activity" banner and a dashed frame stay on screen while it runs.
- **Controls:**
  - start work at home or at a profile's workplace (optionally with progress);
  - ask for approval, approve;
  - complete, fail, stop;
  - press "Start work" several times to see the multiple-runs rule.
- **Isolation:** nothing is sent to Village Hall, and the feed, tasks and approvals stay real. A test checks the module has no way to make requests. **Back to real activity** returns to the real picture.

## Cost

When nothing is happening the cost is unchanged: indicators, Zzz and badges are hidden and drawn nowhere. Overview at High is 241 draws and 542k triangles. Each active indicator adds 4 small draws, and each resting resident with Zzz adds 3 sprites. There are no new lights, no polling (only the existing event stream), no paid calls and no new dependencies.

## Still open

- **A task runner.** Until tasks really run, trips to Blender House or UE Studio happen only in simulation. Chat replies drive the real "work at home" cycle today.
- **Animation clips.** The current character models have no rig or clips, so walking is a gentle procedural bob. For your new Tripo models with idle, walk or work clips, add three.js's `SkeletonUtils` (the matching addon file from the vendored three.js version, no new package) and an `AnimationMixer` per character. The life states map directly to clips.
- **On your PC:**
  - with a connected resident, send a chat and watch the indicator over its home turn blue, then gold;
  - check the frame rate while several residents walk (press **G**);
  - open `?simulate` and walk Claude to Blender House and back.
