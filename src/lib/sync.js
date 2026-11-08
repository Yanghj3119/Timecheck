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
    return { ...remoteCourse, ...localCourse, completed: Math.max(Number(remoteCourse.completed), Number(localCourse.completed)) };
  });
  return {
    courses,
    sessions: mergeByLocalId(remote.sessions, local.sessions),
    trips: mergeByLocalId(remote.trips, local.trips),
  };
}

export async function writeRemoteData(client, userId, data, removedSessionIds = []) {
  const sessions = data.sessions.map(session => ({
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
