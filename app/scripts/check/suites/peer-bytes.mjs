import { peerBytesHttpSuite } from './peer-bytes-http.mjs';
import { peerBytesP2pSuite } from './peer-bytes-p2p.mjs';

export default async function peerBytesSuite() {
  await peerBytesHttpSuite();
  await peerBytesP2pSuite();
}
