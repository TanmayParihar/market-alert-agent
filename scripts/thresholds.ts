import { config } from '../agent.config';
import { thresholdTable } from '../src/core/thresholds';

console.log('Effective price-move thresholds (|% move|) per asset and window. Edit agent.config.ts to change them.\n');
console.log(thresholdTable(config));
console.log('\nLOW = digest only. MEDIUM/HIGH/WORLD = instant. Circuit-breaker and VIX-level rules are separate (see config).');
