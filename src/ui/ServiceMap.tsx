import { isBreaching, isRecovered, SERVICE_NAMES, type Engine, type ServiceName } from "../engine";
import { millis, pct } from "./format";

/**
 * The service inventory, with the dependency edges that make one service's trouble
 * another's symptom. Health is derived from the same thresholds the detector uses —
 * there is no second opinion about what "degraded" means.
 */

type Health = "healthy" | "degraded" | "critical";

function healthOf(engine: Engine, name: ServiceName): Health {
  const point = engine.health(name);
  if (!point) return "healthy";
  const signals = {
    errorRate: point.errorRate,
    p99: point.p99,
    requests: point.requests,
    errors: point.errors,
  };
  if (isBreaching(signals)) return "critical";
  return isRecovered(signals) ? "healthy" : "degraded";
}

export function ServiceMap({
  engine,
  selected,
  onSelect,
}: {
  engine: Engine;
  selected: ServiceName;
  onSelect(service: ServiceName): void;
}) {
  return (
    <ul className="services">
      {SERVICE_NAMES.map((name) => {
        const point = engine.health(name);
        const health = healthOf(engine, name);
        const service = engine.world.services[name];

        return (
          <li key={name}>
            <button
              type="button"
              className={`service is-${health} ${name === selected ? "is-selected" : ""}`}
              onClick={() => onSelect(name)}
              aria-pressed={name === selected}
            >
              <span className={`status-dot is-${health}`} aria-hidden="true" />
              <span className="service-name">{name}</span>

              <span className="service-readout">
                <span>{point ? pct(point.errorRate, 1) : "—"}</span>
                <span>{point ? millis(point.p99) : "—"}</span>
              </span>

              {service.dependencies.length > 0 && (
                <span className="service-deps">calls {service.dependencies.join(", ")}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
