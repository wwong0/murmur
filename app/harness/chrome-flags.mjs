import { FLAGS } from '../scripts/cdp.mjs';

export const CONTAINER_FLAGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
];

export function harnessChromeFlags({ upstreamPort = 9333, windowSize = '1280,720' } = {}) {
  const flags = FLAGS.map((flag) => flag.startsWith('--disable-features=')
    ? '--disable-features=CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns'
    : flag);
  return [
    ...flags,
    ...CONTAINER_FLAGS,
    `--remote-debugging-port=${upstreamPort}`,
    `--window-size=${windowSize}`,
  ];
}
