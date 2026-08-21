import { ActivityIndicator, View } from "react-native";
import { Button, Callout, Card, EmptyState, ErrorNote, T } from "./ui";
import { Medallion, ScheduleRow } from "./InsightsShared";
import { groupSchedules } from "../lib/recurringAgenda";
import { brand, font, ink, paper, radius, space, typeScale } from "../theme/tokens";
import type { RecurringPattern, RecurringSchedule } from "../lib/types";

/**
 * The Recurring sub-section of Expense insight — the payments the owner has
 * told FinSight to watch, and under them the ones FinSight is offering to
 * watch.
 *
 * THAT ORDER IS THE POINT OF THIS SECTION. It used to show only candidates,
 * so a schedule disappeared the moment it was confirmed and there was no
 * screen anywhere that listed what FinSight was actually watching. An owner
 * who had confirmed five payments saw the same "none found yet" empty state
 * as one who had never seen a candidate at all.
 *
 * Split out of ExpenseBehaviorScreen.tsx as a pure presentational piece: the
 * two fetches (schedules, patterns) and the confirm/dismiss/open handlers
 * stay on the screen and are handed down as props.
 */
export function ExpenseRecurringSection({
  patternActionError,
  scheduleState,
  schedules,
  candidates,
  canConfirm,
  openSchedule,
  confirmPattern,
  dismissPattern,
}: {
  patternActionError: string | null;
  scheduleState: { data: RecurringSchedule[] | null; loading: boolean };
  /**
   * `null` when the agenda could not be read (typically the server's
   * ANOMALY_RECURRING_ENABLED flag being off) — see recurringAvailability.
   */
  schedules: RecurringSchedule[] | null;
  candidates: RecurringPattern[];
  canConfirm: boolean;
  openSchedule: (scheduleId?: number) => void;
  confirmPattern: (id: number) => void | Promise<void>;
  dismissPattern: (id: number) => void | Promise<void>;
}) {
  return (
    <>
      {/*
        NO ERROR NOTE FOR THE SCHEDULES READ. It used to print the
        server's own "Not found" here, which is the 404 the feature
        flag returns by design — an owner was being shown the
        plumbing of a feature that has not shipped. The agenda's
        absence IS the message; see recurringAvailability.

        `patternActionError` stays: that one is about a button the
        owner just pressed, and it is still reachable through
        "Not recurring", which is ungated.
      */}
      {patternActionError ? <ErrorNote>{patternActionError}</ErrorNote> : null}
      {scheduleState.loading && scheduleState.data === null && schedules !== null ? (
        <ActivityIndicator color={brand[600]} />
      ) : null}

      {/*
        THE ONLY STATE THAT MAY SAY "NOTHING HERE".

        Both lists empty — nothing declared and nothing offered. The
        old condition tested candidates alone, which told an owner
        with schedules on file that none had been found.

        `schedules !== null` is the second half of that same rule and
        the more important one: an unread agenda is not an empty one.
      */}
      {schedules !== null && schedules.length === 0 && candidates.length === 0 && !scheduleState.loading ? (
        <EmptyState
          title="No repeating payments yet"
          // `icon`, not a mascot: docs/mascot-scenario-library.md maps
          // this state to a pose, but 04-empty-states/ ships no files
          // on either client, and require()-ing a path that is not
          // there is a build error rather than a missing picture.
          icon="↻"
          body="Rent, wages, a delivery you pay every week — add one and FinSight will tell you when it's late. It also offers them here once it notices the same expense a few times."
          action={
            <Button
              title="Add a repeating payment"
              variant="primary"
              onPress={() => openSchedule()}
            />
          }
        />
      ) : null}

      {/*
        THE AGENDA. Grouped on the server's own `dueState` — see
        lib/recurringAgenda.ts for why none of this is worked out
        from the date here.
      */}
      {groupSchedules(schedules ?? []).map((group) => (
        <View key={group.key}>
          <T
            variant="heading"
            accessibilityRole="header"
            style={{ color: brand[900], marginBottom: 2 }}
          >
            {group.title}
          </T>
          <T variant="caption" style={{ marginBottom: space.sm }}>
            {group.caption}
          </T>
          {group.items.map((schedule) => (
            <ScheduleRow
              key={schedule.id}
              schedule={schedule}
              onPress={() => openSchedule(schedule.id)}
            />
          ))}
        </View>
      ))}

      {/*
        The add button goes with the agenda, not beside it: creating
        a schedule is POST /insights/recurring-schedules, behind the
        same gate as the read, so offering it while the agenda is
        unavailable would walk the owner into a form that cannot save.
      */}
      {schedules !== null && schedules.length > 0 ? (
        <Button
          title="Add a repeating payment"
          variant="secondary"
          onPress={() => openSchedule()}
        />
      ) : null}

      {/*
        CANDIDATES, kept but demoted. They are FinSight's suggestions,
        not the owner's list, and a suggestion should not outrank a
        commitment.
      */}
      {candidates.length > 0 ? (
        <Card>
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start", marginBottom: space.md }}>
            <Medallion icon="sparkles-outline" tint={brand[700]} surface={brand[50]} />
            <View style={{ flex: 1 }}>
              <T variant="heading" accessibilityRole="header">FinSight noticed these repeat</T>
              {/*
                The caption promises what the buttons below can
                actually do. With confirming unavailable there is no
                "list above" to join, and repeating the promise
                anyway would send the owner looking for a button
                that is deliberately not there.
              */}
              <T variant="caption" style={{ marginTop: 2 }}>
                {canConfirm
                  ? "Confirm one and it joins the list above, where you can edit or pause it."
                  : "Spotted in your records. Tell FinSight which of these aren't worth a second look."}
              </T>
            </View>
          </View>
          <View style={{ gap: space.sm }}>
            {candidates.map((pattern) => (
              <View
                key={pattern.id}
                style={{
                  borderWidth: 1,
                  borderColor: paper[200],
                  borderRadius: radius.md,
                  padding: space.md,
                }}
              >
                <T style={{ fontSize: typeScale.bodySm, color: ink[900], fontFamily: font.sansSemibold }}>
                  {pattern.description}
                </T>
                <T variant="caption" style={{ marginTop: 2 }}>
                  {pattern.category.name} · About every {pattern.intervalDays} days
                </T>
                {/*
                  "Confirm recurring" and "Not recurring" in two
                  half-width buttons wrapped to two lines each on a
                  normal phone, which made a routine yes/no look like a
                  paragraph. The question is already asked by the card
                  above them, so the answers can be the one word that
                  differs: Confirm, and Not recurring.
                */}
                {/*
                  CONFIRM IS HIDDEN, NOT DISABLED, when the agenda is
                  unavailable. POST .../confirm creates a schedule, so
                  it is behind the same server gate as the read and
                  can only 404 — and a greyed-out button still
                  advertises a capability, sending the owner hunting
                  for whatever would switch it back on. Web hides it
                  the same way, for the same reason
                  (web/src/pages/ExpenseInsight.tsx).

                  "Not recurring" stays either way: PATCH
                  /insights/recurring-patterns/:id is ungated, so
                  dismissing a bad guess still works.
                */}
                <View style={{ flexDirection: "row", gap: space.sm, marginTop: space.md }}>
                  {canConfirm ? (
                    <View style={{ flex: 1 }}>
                      <Button
                        title="Confirm"
                        variant="brand"
                        onPress={() => void confirmPattern(pattern.id)}
                      />
                    </View>
                  ) : null}
                  <View style={{ flex: 1 }}>
                    <Button
                      title="Not recurring"
                      variant="secondary"
                      onPress={() => void dismissPattern(pattern.id)}
                    />
                  </View>
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      {/*
        WHAT WATCHING ACTUALLY BUYS, and only what it buys.

        This used to promise a notification for late, early AND
        changed amounts. Only the first is delivered: the backend
        emits a notification when a scheduled payment goes unrecorded
        past its date, and when one is coming up. An early repeat or
        a changed amount is raised as a finding on the Alerts tab and
        nothing is sent. Said accurately here rather than generously,
        because a promise of an alert that never arrives is worse
        than no promise — the owner stops watching for it themselves.
      */}
      {schedules !== null && (schedules.length > 0 || candidates.length > 0) ? (
        <Callout tone="info">
          You'll be notified when a payment on this list is due or goes unrecorded past its date.
          A different amount, or an extra payment sooner than expected, shows up under Alerts
          rather than as a notification.
        </Callout>
      ) : null}
    </>
  );
}
