import { useState } from "react";
import { SCENARIO_IDS, SCENARIO_LABELS, type ScenarioId, type ServiceName } from "../engine";
import { SPEED_MULTIPLIERS, type SpeedMultiplier } from "../engine/constants";
import {
  GC_ERROR_ONSET,
  GC_ONSET,
  INCIDENT_ERROR_RATE_THRESHOLD,
  INCIDENT_P99_THRESHOLD_MS,
  RECOVERY_P99_MS,
  SEV2_ERROR_RATE,
  SEV2_P99_MS,
} from "../engine/constants";
import { webmcpAvailable } from "../mcp/register";
import { useSimulation } from "./useSimulation";
import { AlarmRail } from "./AlarmRail";
import { ServiceMap } from "./ServiceMap";
import { MetricChart } from "./MetricChart";
import { EvidenceTabs } from "./EvidenceTabs";
import { Vitals } from "./Vitals";
import { IncidentRecord } from "./IncidentRecord";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { session } from "../session";
import { millis, pct, rate, simClock } from "./format";

/**
 * Three regions, and the order is the argument the product makes: the environment you
 * are responsible for, the evidence it is producing, and the record of what anyone did
 * about it. Investigation sits between the system and the action, never beside it.
 */

export function App() {
  const sim = useSimulation();
  const [service, setService] = useState<ServiceName>("checkout-service");

  const { engine } = sim;
  const incident = engine.incident;
  const focus = incident?.openingSignals.service ?? service;
  const points = engine.store.metrics[service];

  return (
    <div className="shell">
      <header className="topbar">
        <h1>AgentOps</h1>
        <span className="tag">Incident Response</span>

        <span className="clock" title="Simulated time since the environment started">
          {simClock(engine.world.nowMs)}
        </span>

        {/*
          FR-2.1 — scenarios are selectable by name, and the name is a number. A label
          reading "memory leak" would hand a judge the diagnosis before they looked, and
          FR-2.5 forbids the tool layer from disclosing it at all; the interface should
          not undo through a dropdown what the tool contracts are careful to withhold.
        */}
        <label className="scenario-pick">
          <span className="scenario-pick-label">Scenario</span>
          <select
            value={sim.scenario}
            onChange={(event) => sim.setScenario(event.target.value as ScenarioId)}
          >
            {SCENARIO_IDS.map((id) => (
              <option key={id} value={id}>
                {SCENARIO_LABELS[id]}
              </option>
            ))}
          </select>
        </label>

        <div className="speeds" role="group" aria-label="Simulation speed">
          {SPEED_MULTIPLIERS.map((multiplier) => (
            <button
              key={multiplier}
              type="button"
              className={`speed ${sim.speed === multiplier ? "is-active" : ""}`}
              aria-pressed={sim.speed === multiplier}
              onClick={() => sim.setSpeed(multiplier as SpeedMultiplier)}
            >
              {multiplier}×
            </button>
          ))}
        </div>

        <button type="button" className="ghost" onClick={sim.reset}>
          Reset environment
        </button>

        <span className="topbar-spacer" />

        <span className="pill">
          <span className={`dot ${webmcpAvailable() ? "on" : "off"}`} />
          {webmcpAvailable() ? "WebMCP connected" : "WebMCP unavailable"}
        </span>
      </header>

      <AlarmRail incident={incident} point={engine.health(focus)} serviceLabel={focus} />

      {/*
        FR-8.9 — above the working columns, full width, and impossible to work around.
        An agent's tool call is suspended on this decision, so the interface should not
        let anyone continue as though nothing were pending.
      */}
      {sim.awaitingApproval && (
        <ApprovalPrompt
          proposal={sim.awaitingApproval}
          engine={engine}
          evidence={session().evidence}
          onApprove={sim.approve}
          onDeny={sim.deny}
        />
      )}

      <main className="regions">
        <section className="region region-environment">
          <h2 className="region-head">
            Environment
            <span className="region-note">5 services</span>
          </h2>
          <ServiceMap engine={engine} selected={service} onSelect={setService} />
        </section>

        <section className="region region-evidence">
          <h2 className="region-head">
            Evidence
            <span className="region-note">{service}</span>
          </h2>

          <div className="charts">
            {/*
              Rate, errors, duration — the three signals in the order an on-call engineer
              reads them. Throughput comes first because it is the question that decides
              whether the other two mean anything: traffic holding steady while errors
              climb is a different incident from traffic doubling.
            */}
            <MetricChart
              points={points}
              field="requests"
              title="Throughput"
              format={rate}
            />
            <MetricChart
              points={points}
              field="p99"
              title="Latency p99"
              format={millis}
              floor={RECOVERY_P99_MS}
              thresholds={[
                { value: INCIDENT_P99_THRESHOLD_MS, label: "opens" },
                { value: SEV2_P99_MS, label: "SEV-2" },
              ]}
            />
            <MetricChart
              points={points}
              field="errorRate"
              title="Error rate"
              format={(v) => pct(v, 1)}
              floor={0.04}
              thresholds={[
                { value: INCIDENT_ERROR_RATE_THRESHOLD, label: "opens" },
                { value: SEV2_ERROR_RATE, label: "SEV-2" },
              ]}
            />
            {/*
              Memory earns its place on the wall for the same reason the alarm rail
              exists: a leak is diagnosable only if you can watch the climb and see which
              line it is about to cross. The thresholds drawn here are the ones the
              simulation actually uses — the collector starts costing latency at one, the
              service starts shedding requests at the other — so a human reads the same
              two numbers the engine does rather than a number with no scale behind it.
            */}
            <MetricChart
              points={points}
              field="memory"
              title="Heap used"
              format={(v) => pct(v, 0)}
              floor={0.6}
              thresholds={[
                { value: GC_ONSET, label: "collecting" },
                { value: GC_ERROR_ONSET, label: "shedding" },
              ]}
            />
          </div>

          <Vitals point={engine.health(service)} />

          <EvidenceTabs engine={engine} service={service} />
        </section>

        <section className="region region-record">
          <h2 className="region-head">
            Record
            <span className="region-note">human · no agent required</span>
          </h2>
          <IncidentRecord
            engine={engine}
            audit={sim.audit}
            service={service}
            proposals={sim.proposals}
            onRemediate={sim.remediate}
            onStatus={sim.setStatus}
          />
        </section>
      </main>
    </div>
  );
}
