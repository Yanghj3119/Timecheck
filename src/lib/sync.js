export function addLocalIds(data) {
  const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    ...data,
    sessions: (data.sessions ?? []).map(session => ({
      ...session,
      localId: session.localId || session.at || makeId(),
    })),
    trips: (data.trips ?? []).map(trip => ({ ...trip, localId: trip.localId || makeId() })),
    courses: (data.courses ?? []).map(course => ({ ...course, localId: course.localId || course.id })),
  };
}

const mergeByLocalId = (remote, local) => {
  const merged = new Map(remote.map(row => [row.localId, row]));
  local.forEach(row => merged.set(row.localId, { ...merged.get(row.localId), ...row }));
  return [...merged.values()];
};

export async function readRemoteData(client, userId) {
  const [sessionsResult, tripsResult, coursesResult] = await Promise.all([
    client.from('study_sessions').select('local_id, course_key, study_date, subject, study_type, minutes, memo, created_at').eq('user_id', userId),
    client.from('travel_routes').select('local_id, route, minutes, note').eq('user_id', userId),
    client.from('study_courses').select('local_id, subject, title, total_lectures, completed_lectures').eq('user_id', userId),
  ]);
  for (const result of [sessionsResult, tripsResult, coursesResult]) {
    if (result.error) throw result.error;
  }
  return {
    sessions: (sessionsResult.data ?? []).map(row => ({
      localId: row.local_id,
      courseId: row.course_key,
      date: row.study_date,
      subject: row.subject,
      kind: row.study_type,
      minutes: row.minutes,
      memo: row.memo,
      at: row.created_at,
    })),
    trips: (tripsResult.data ?? []).map(row => ({ localId: row.local_id, route: row.route, minutes: row.minutes, note: row.note })),
    courses: (coursesResult.data ?? []).map(row => ({
      id: row.local_id,
      localId: row.local_id,
      subject: row.subject,
      title: row.title,
      total: row.total_lectures,
      completed: row.completed_lectures,
    })),
  };
}

export function mergeStudyData(remote, local) {
  const localCourses = new Map(local.courses.map(course => [course.localId, course]));
  const remoteCourses = new Map(remote.courses.map(course => [course.localId, course]));
  const courses = [...new Set([...remoteCourses.keys(), ...localCourses.keys()])].map(id => {
    const localCourse = localCourses.get(id);
    const remoteCourse = remoteCourses.get(id);
    if (!localCourse) return remoteCourse;
    if (!remoteCourse) return localCourse;
    return {
      ...remoteCourse,
      ...localCourse,
      completed: Number(local.progressRevision || 0) >= 2
        ? Number(localCourse.completed)
        : Math.max(Number(remoteCourse.completed), Number(localCourse.completed)),
    };
  });
  return {
    ...remote,
    ...local,
    courses,
    sessions: mergeByLocalId(remote.sessions, local.sessions),
    trips: mergeByLocalId(remote.trips, local.trips),
  };
}

// Merge the server copy with this device's copy. A session that this device already
// uploaded earlier but that is now missing on the server was deleted on another device,
// so it is dropped instead of being uploaded again.
export function reconcileStudyData(remote, local, syncedIds = new Set()) {
  // An empty server answer is never treated as "everything was deleted": the server may
  // be unreadable or wiped, so this device keeps its records (and uploads them again).
  if (!remote.sessions.length && local.sessions.length) return mergeStudyData(remote, local);
  const remoteIds = new Set(remote.sessions.map(session => session.localId));
  const keptSessions = local.sessions.filter(session => !syncedIds.has(session.localId) || remoteIds.has(session.localId));
  return mergeStudyData(remote, { ...local, sessions: keptSessions });
}

// skipSessionIds: sessions already on the server. They are not uploaded again, so a device
// with an out-of-date copy can never bring back a record that was deleted elsewhere.
export async function writeRemoteData(client, userId, data, removedSessionIds = [], skipSessionIds = new Set()) {
  // The database only accepts sessions longer than 0 minutes.
  const sessions = data.sessions.filter(session => Number(session.minutes) > 0 && !skipSessionIds.has(session.localId || session.at)).map(session => ({
    user_id: userId,
    local_id: session.localId || session.at,
    course_key: session.courseId || null,
    study_date: session.date,
    subject: session.subject,
    study_type: session.kind,
    minutes: Number(session.minutes),
    memo: session.memo || '',
    created_at: session.at || new Date().toISOString(),
  }));
  const trips = data.trips.map(trip => ({ user_id: userId, local_id: trip.localId, route: trip.route, minutes: Number(trip.minutes), note: trip.note || '' }));
  const courses = data.courses.map(course => ({
    user_id: userId,
    local_id: course.localId || course.id,
    subject: course.subject,
    title: course.title,
    total_lectures: Number(course.total),
    completed_lectures: Number(course.completed),
  }));

  const writes = [
    sessions.length && client.from('study_sessions').upsert(sessions, { onConflict: 'user_id,local_id' }),
    trips.length && client.from('travel_routes').upsert(trips, { onConflict: 'user_id,local_id' }),
    courses.length && client.from('study_courses').upsert(courses, { onConflict: 'user_id,local_id' }),
  ].filter(Boolean);
  const results = await Promise.all(writes);
  const error = results.find(result => result.error)?.error;
  if (error) throw error;

  for (const localId of removedSessionIds) {
    const { error: deleteError } = await client.from('study_sessions').delete().eq('user_id', userId).eq('local_id', localId);
    if (deleteError) throw deleteError;
  }
}
