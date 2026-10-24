export async function probeStorage(getDirectory) {
  try {
    await getDirectory();
    return { ok: true };
  } catch (error) {
    return { ok: false, name: error?.name || 'Error' };
  }
}
