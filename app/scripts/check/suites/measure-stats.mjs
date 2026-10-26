import { assertEqual, check } from '../harness.mjs';
import { median, percentile, weightedPercentile } from '../../measure/stats.mjs';

export default async function measureStatsSuite() {
  await check('measurement stats: interpolated and weighted percentiles', async () => {
    assertEqual(median([1, 2, 3, 4]), 2.5, 'median interpolates an even list');
    assertEqual(percentile(Array.from({ length: 101 }, (_, index) => index + 1), 0.99), 100, 'p99 uses linear interpolation');
    assertEqual(weightedPercentile([[5, 1], [10, 3]], 0.5), 10, 'weighted percentile reaches the cumulative threshold');
    assertEqual(median([]), null, 'empty median is absent');
  });
}
