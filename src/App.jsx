import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CalendarDays, ChartNoAxesColumn, Clock3, Coffee, Home, MapPin, Plus, Settings2, Sparkles, Target, Train, X, Check, ChevronLeft, ChevronRight, ArrowRight, BriefcaseBusiness, Cloud, CloudOff, LogOut } from 'lucide-react';
import { supabase, supabaseConfigured } from './lib/supabase.js';
import { addLocalIds, reconcileStudyData, readRemoteData, writeRemoteData } from './lib/sync.js';

const subjects = ['영어', '국어', '행정법', '행정학'];
const initialCourses = [
  { id: 'kor-basic', subject: '국어', title: '[2027] 배영표 국어 기본이론', total: 64, completed: 16 },
  { id: 'eng-basic', subject: '영어', title: '[2027] 헤더진 영어 기본이론', total: 60, completed: 10 },
  { id: 'admin-basic', subject: '행정학', title: '[2027] 이광호 행정학개론 기본이론', total: 64, completed: 3 },
  { id: 'law-basic', subject: '행정법', title: '[2027] 이재준 행정법총론 기본이론', total: 67, completed: 9 },
];
const coreCourseIds = new Set(initialCourses.map(course => course.id));
const weekdays = ['월', '화', '수', '목', '금', '토', '일'];
const baseHours = [6, 6, 6, 9, 9, 9, 5];
const seed = {
  sessions: [],
  courses: initialCourses,
  trips: [
    { route: '집 → 탐라도서관', minutes: 9, note: '도보 · 실측' },
    { route: '도서관 → 편의점', minutes: 13, note: '도보 · 실측' },
    { route: '편의점 → 스터디카페', minutes: 13, note: '도보 · 실측' },
    { route: '스터디카페 → 집', minutes: 2, note: '도보 · 실측' },
  ],
};
const load = () => {
  try {
    const saved = JSON.parse(localStorage.getItem('pass-note') || '{}');
    const migrateProgress = Array.isArray(saved.courses) && Number(saved.progressRevision || 0) < 2;
    const courses = saved.courses
      ? saved.courses.filter(course => coreCourseIds.has(course.id)).map(course => {
          if (!migrateProgress) return course;
          const current = initialCourses.find(item => item.id === course.id);
          return current ? { ...course, completed: current.completed, total: current.total, subject: current.subject, title: current.title } : course;
        })
      : initialCourses;
    return { ...seed, ...saved, courses, progressRevision: migrateProgress ? 2 : Number(saved.progressRevision || 0) };
  } catch { return seed; }
};
const todayKey = () => new Intl.DateTimeFormat('sv-SE').format(new Date());
const fmt = (mins) => `${Math.floor(mins / 60)}시간 ${mins % 60}분`;
const fmtHours = (hours) => Number.isInteger(hours) ? hours : Number(hours.toFixed(1));
const fmtMinutes = (mins) => `${Math.floor(mins / 60) ? `${Math.floor(mins / 60)}시간 ` : ''}${mins % 60 ? `${mins % 60}분` : ''}`.trim() || '0분';
const studyDate = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d; };
const dateKey = (d) => new Intl.DateTimeFormat('sv-SE').format(d);
const dayName = (d) => weekdays[(d.getDay() + 6) % 7];
const lecturePlanStart = new Date(2026, 10, 11);
const lecturePlanDays = 28;
const lecturePlanEnd = '2026-12-08';
const noStudyDates = new Set(['2026-12-09', '2026-12-10']);

// How many lectures each day can hold, as a share (largest-remainder rounding).
function quotasByWeight(total, weights) {
  const sum = weights.reduce((a, w) => a + w, 0);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map(w => total * w / sum);
  const quotas = raw.map(Math.floor);
  let left = total - quotas.reduce((a, q) => a + q, 0);
  raw.map((value, i) => [value - quotas[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).forEach(([, i]) => { if (left > 0 && weights[i] > 0) { quotas[i]++; left--; } });
  return quotas;
}
// Study capacity per day: part-time work in the evening (Mon–Wed 20:00–24:00) or on 11/20
// afternoon leaves less time for lectures than a free day.
const lectureDayWeight = (date) => {
  const key = dateKey(date);
  if (noStudyDates.has(key)) return 0;
  if (key === '2026-11-20') return 0.5;
  if (key === '2026-11-12' || key === '2026-11-13' || [1, 2, 3].includes(date.getDay())) return 0.7;
  return 1;
};

function allocateLectureDays(courses, remaining, dates, weightFn = null) {
  const total = remaining.reduce((sum, count) => sum + count, 0);
  if (!dates.length) return [];
  const lighterIndexes = dates.map((date, i) => dateKey(date) === '2026-11-20' ? i : -1).filter(i => i >= 0);
  const fixed = new Map(lighterIndexes.map(i => [i, Math.min(6, Math.max(0, total))]));
  const fixedTotal = [...fixed.values()].reduce((sum, count) => sum + count, 0);
  const flexibleDays = dates.length - fixed.size;
  const flexibleTotal = Math.max(0, total - fixedTotal);
  const base = flexibleDays ? Math.floor(flexibleTotal / flexibleDays) : 0;
  const extra = flexibleDays ? flexibleTotal % flexibleDays : 0;
  let flexibleIndex = 0;
  let quotas = dates.map((_, dayIndex) => {
    if (fixed.has(dayIndex)) return fixed.get(dayIndex);
    const quota = base + (Math.floor((flexibleIndex + 1) * extra / Math.max(1, flexibleDays)) > Math.floor(flexibleIndex * extra / Math.max(1, flexibleDays)) ? 1 : 0);
    flexibleIndex++;
    return quota;
  });
  if (weightFn) quotas = quotasByWeight(total, dates.map(weightFn));
  const assigned = courses.map(() => 0);
  let slot = 0;
  return dates.map((date, dayIndex) => {
    const counts = courses.map(() => 0);
    for (let n = 0; n < quotas[dayIndex] && slot < total; n++) {
      let best = -1;
      let bestScore = -Infinity;
      courses.forEach((course, i) => {
        if (assigned[i] >= remaining[i]) return;
        if (course.id === 'eng-basic' && dateKey(date) < '2026-11-11') return;
        const score = ((slot + 1) * remaining[i] / Math.max(1, total)) - assigned[i];
        if (score > bestScore) { best = i; bestScore = score; }
      });
      if (best < 0) break;
      assigned[best]++;
      counts[best]++;
      slot++;
    }
    return { date, goal: counts.reduce((sum, count) => sum + count, 0), tasks: courses.map((course, i) => ({ course, count: counts[i] })).filter(task => task.count) };
  });
}

const lectureMarkerPattern = /\[lec:(\d+)\]/;
// The starting progress (initialCourses.completed) was set on 11/11 around 14:00 KST.
const baselineCutMs = Date.parse('2026-11-11T05:30:00Z');
const lectureMarkedNumbers = (sessions) => sessions
  .filter(session => session.courseId && session.kind === '인강 시청')
  .map(session => Number((String(session.memo || '').match(lectureMarkerPattern) || [])[1]))
  .filter(Boolean);
// Which lecture numbers are finished per course, derived only from synced sessions so
// every device agrees: the starting progress, older sessions without a [lec:N] marker
// (counted in order), and numbered sessions.
function lectureDoneSets(courses, sessions) {
  return new Map(courses.map(course => {
    const own = sessions.filter(session => session.courseId === course.id && session.kind === '인강 시청');
    const marked = new Set(lectureMarkedNumbers(own));
    const base = Number(initialCourses.find(item => item.id === course.id)?.completed ?? course.completed ?? 0);
    const done = new Set(marked);
    for (let n = 1; n <= Math.min(Number(course.total), base); n++) done.add(n);
    // Older records have no [lec:N] marker. Their memo usually says which lecture it was
    // ("16강 수강 완료"); the starting progress already includes records saved before it was set.
    let unnumbered = 0;
    own.filter(session => !lectureMarkerPattern.test(String(session.memo || ''))).forEach(session => {
      const written = String(session.memo || '').match(/(\d+)강 수강 완료/);
      if (written) done.add(Number(written[1]));
      else if ((Date.parse(session.at) || 0) > baselineCutMs) unnumbered++;
    });
    for (let n = base + 1; unnumbered > 0 && n <= Number(course.total); n++) {
      if (!done.has(n)) { done.add(n); unnumbered--; }
    }
    return [course.id, done];
  }));
}
// Progress counts always follow the recorded sessions, so phone and PC cannot drift apart.
function withDerivedProgress(data) {
  const courses = data.courses || [];
  const sets = lectureDoneSets(courses, data.sessions || []);
  return { ...data, courses: courses.map(course => ({ ...course, completed: Math.min(Number(course.total), sets.get(course.id).size) })) };
}
// Catch-up sessions are real study time, but they belong to the missed day, not to today's plan.
const isCatchupSession = (session) => /^\[catchup/.test(String(session.memo || '')) || String(session.memo || '').includes('미완료분 보충');
// Starting exams, used until the user adds or edits exams in the app (date: null while undecided).
const defaultExams = [
  { id: 'national', short: '국가직', name: '국가직 9급 공무원 시험', track: '일반행정', date: '2027-03-27' },
  { id: 'local', short: '지방직', name: '지방직 9급 공무원 시험', track: '일반행정', date: null },
];
const daysUntil = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  const now = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
};
const ddayLabel = (dateStr) => {
  if (!dateStr) return '일정 미정';
  const days = daysUntil(dateStr);
  return days === 0 ? 'D-DAY' : days > 0 ? `D-${days}` : `D+${-days}`;
};
const examDateText = (exam) => {
  if (!exam.date) return '일정 미정';
  const [y, m, d] = exam.date.split('-').map(Number);
  return `${y}년 ${m}월 ${d}일(${['일', '월', '화', '수', '목', '금', '토'][new Date(y, m - 1, d).getDay()]})`;
};
// The closest upcoming exam with a date; falls back to the first exam when none is dated.
const nearestExam = (list) => list.filter(exam => exam.date && daysUntil(exam.date) >= 0).sort((x, y) => daysUntil(x.date) - daysUntil(y.date))[0] || list[0] || null;
// Exams are stored as 1-minute placeholder sessions (kind '시험') so they sync like other records.
const isPseudoSession = (session) => session.kind === '메모' || session.kind === '시험' || session.kind === '계획';
// "Replan from what is left": the newest 계획 record says from which day, and at which
// moment, the remaining lectures were spread again over the days up to the end date.
const latestRebase = (sessions) => sessions.filter(s => s.kind === '계획').map(s => {
  try { const value = JSON.parse(s.memo); return value && value.date && value.at ? { date: value.date, from: value.from || value.date, at: value.at, atMs: Date.parse(value.at) || 0 } : null; } catch { return null; }
}).filter(Boolean).sort((a, b) => b.atMs - a.atMs)[0] || null;
const parseExam = (session) => { try { const exam = JSON.parse(session.memo); return exam && exam.name && !exam.empty ? exam : null; } catch { return null; } };
const tabLabels = ['홈', '오늘의 시간표', '일정', '공부 기록', '학습 통계 및 진도', '설정'];
const newestFirst = (a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0) || String(b.date).localeCompare(String(a.date));
const cleanMemo = (memo) => String(memo || '').replace(/\[(?:lec:\d+|catchup(?::[^\]]*)?|extra)\]\s*/g, '').trim();
const nextUndoneLecture = (course, doneSet) => {
  for (let n = 1; n <= Number(course.total); n++) if (!doneSet.has(n)) return n;
  return null;
};

function buildLecturePlan(courses, sessions = [], today = new Date()) {
  const dates = Array.from({ length: lecturePlanDays }, (_, i) => {
    const date = new Date(lecturePlanStart);
    date.setDate(date.getDate() + i);
    return date;
  });
  const todayKeyValue = dateKey(today);
  const startKey = dateKey(lecturePlanStart);
  const planSessions = sessions.filter(session =>
    session.courseId && session.kind === '인강 시청' &&
    session.date >= startKey && session.date <= lecturePlanEnd
  );
  const planStartKey = '2026-11-11';
  const firstRebalanceKey = '2026-11-12';
  const initialById = new Map(initialCourses.map(course => [course.id, course]));
  const initialRemaining = courses.map(course => {
    const baseline = initialById.get(course.id);
    return Math.max(0, Number(baseline?.total ?? course.total) - Number(baseline?.completed ?? 0));
  });
  const baselineTodayTasks = [
    { courseId: 'eng-basic', count: 2 },
    { courseId: 'admin-basic', count: 1 },
  ].map(task => ({
    course: courses.find(course => course.id === task.courseId),
    count: task.count,
  })).filter(task => task.course && task.count > 0);
  const baselineToday = {
    date: new Date(lecturePlanStart),
    goal: baselineTodayTasks.reduce((sum, task) => sum + task.count, 0),
    tasks: baselineTodayTasks,
  };
  const postStartDates = dates.filter(date => dateKey(date) >= firstRebalanceKey);
  const baselinePostStart = allocateLectureDays(initialCourses, initialRemaining, postStartDates);
  const baselineByDate = new Map([
    [planStartKey, baselineToday],
    ...baselinePostStart.map(day => [dateKey(day.date), day]),
  ]);

  // The plan moves forward with the calendar: every date keeps its original lecture
  // count, and missed lectures are NOT carried into later days. Lecture numbers follow
  // the plan, but jump ahead when the user has actually watched more than planned.
  const baseDays = dates.map(date => {
    const key = dateKey(date);
    const day = baselineByDate.get(key) || { date, goal: 0, tasks: [] };
    return {
      ...day,
      tasks: day.tasks.map(({ course, count }) => ({ course: courses.find(item => item.id === course.id) || course, count })),
    };
  });

  // Lecture numbers are tracked one by one. Past days keep the original numbering.
  // Today and later days take the next lectures that are not watched yet, so extra
  // lectures watched early push later numbers forward, and missed ones never move.
  const doneSets = lectureDoneSets(courses, sessions);
  const doneBeforeToday = new Map(courses.map(course => {
    const watchedToday = new Set(lectureMarkedNumbers(sessions.filter(session => session.courseId === course.id && session.date === todayKeyValue)));
    return [course.id, new Set([...doneSets.get(course.id)].filter(n => !watchedToday.has(n)))];
  }));
  const nextNumber = new Map(initialCourses.map(course => [course.id, Number(course.completed) + 1]));
  const baselineDays = baseDays.map(day => {
    const key = dateKey(day.date);
    const isPast = key < todayKeyValue;
    const isToday = key === todayKeyValue;
    const tasks = day.tasks.map(({ course, count }) => {
      const total = Number(course.total);
      const skip = isPast ? new Set() : isToday ? doneBeforeToday.get(course.id) : doneSets.get(course.id);
      let n = nextNumber.get(course.id) || 1;
      const lectureNumbers = [];
      while (lectureNumbers.length < count && n <= total) {
        if (!skip.has(n)) lectureNumbers.push(n);
        n++;
      }
      nextNumber.set(course.id, n);
      return { course, count: lectureNumbers.length, lectureNumbers };
    }).filter(task => task.count > 0);
    return { ...day, goal: tasks.reduce((sum, task) => sum + task.count, 0), tasks };
  });

  // After a replan, every lecture that was still not watched at that moment (including
  // missed ones) is spread evenly from the replan day to the end date. From then on the
  // plan is fixed again: missed lectures stay in the catch-up list and do not move.
  const rebase = latestRebase(sessions);
  let numberedDays = baselineDays;
  if (rebase && rebase.date <= lecturePlanEnd) {
    const doneAtRebase = lectureDoneSets(courses, sessions.filter(session => (Date.parse(session.at) || 0) < rebase.atMs));
    const candidates = new Map(courses.map(course => [course.id, Array.from({ length: Number(course.total) }, (_, i) => i + 1).filter(n => !doneAtRebase.get(course.id).has(n))]));
    const rebaseDates = dates.filter(date => dateKey(date) >= (rebase.from || rebase.date));
    const allocated = allocateLectureDays(courses, courses.map(course => candidates.get(course.id).length), rebaseDates, lectureDayWeight);
    const pointer = new Map(courses.map(course => [course.id, 0]));
    const rebuilt = new Map(allocated.map(day => {
      const key = dateKey(day.date);
      const isPast = key < todayKeyValue;
      const isToday = key === todayKeyValue;
      const tasks = day.tasks.map(({ course, count }) => {
        const list = candidates.get(course.id);
        const skip = isPast ? new Set() : isToday ? doneBeforeToday.get(course.id) : doneSets.get(course.id);
        let p = pointer.get(course.id);
        const lectureNumbers = [];
        while (lectureNumbers.length < count && p < list.length) {
          const n = list[p++];
          if (!skip.has(n)) lectureNumbers.push(n);
        }
        pointer.set(course.id, p);
        return { course, count: lectureNumbers.length, lectureNumbers };
      }).filter(task => task.count > 0);
      return [key, { ...day, goal: tasks.reduce((sum, task) => sum + task.count, 0), tasks }];
    }));
    numberedDays = baselineDays.map(day => {
      const key = dateKey(day.date);
      return rebuilt.get(key) || (key >= rebase.date ? { ...day, goal: 0, tasks: [] } : day);
    });
  }

  return numberedDays.map(day => {
    const key = dateKey(day.date);
    const actualByCourse = courses.map(course =>
      planSessions.filter(session => session.courseId === course.id && session.date === key && !isCatchupSession(session)).length
    );
    const missedTasks = key < todayKeyValue
      ? day.tasks.map(({ course, lectureNumbers }) => {
          const missing = lectureNumbers.filter(n => !doneSets.get(course.id).has(n));
          return { course, count: missing.length, lectureNumbers: missing };
        }).filter(task => task.count)
      : [];
    const actualMinutes = sessions.filter(session => session.date === key && !isPseudoSession(session) && !isCatchupSession(session))
      .reduce((sum, session) => sum + Number(session.minutes), 0);
    const vocabularyMinutes = sessions.filter(session => session.date === key && session.kind === '단어 암기' && !isCatchupSession(session))
      .reduce((sum, session) => sum + Number(session.minutes), 0);
    // Missed study never changes later days: it only shows up in the catch-up list.
    const wordRecoveryMinutes = 0;
    return {
      ...day,
      actualLectures: actualByCourse.reduce((sum, count) => sum + count, 0),
      actualMinutes,
      missedLectures: missedTasks.reduce((sum, task) => sum + task.count, 0),
      missedTasks,
      missedWordMinutes: key < todayKeyValue ? Math.max(0, 60 - vocabularyMinutes) : 0,
      wordRecoveryMinutes,
      wordMinutes: 60 + wordRecoveryMinutes,
      recoveryLectures: 0,
    };
  });
}
function buildStudyBacklog(lecturePlan, sessions, courses) {
  const doneSets = lectureDoneSets(courses, sessions);
  const lectureWatchDates = new Map();
  sessions.filter(session => session.courseId && session.kind === '인강 시청').forEach(session => {
    const number = Number((String(session.memo || '').match(lectureMarkerPattern) || [])[1]);
    if (number) lectureWatchDates.set(`${session.courseId}|${number}`, session.date);
  });
  const completed = new Map();
  sessions.forEach(session => {
    const match = String(session.memo || '').match(/^\[catchup:([^\]]+)\]/);
    if (match) completed.set(match[1], session);
  });
  const pending = [];
  const done = [];
  const rebase = latestRebase(sessions);
  lecturePlan.filter(day => dateKey(day.date) < todayKey()).forEach(day => {
    const dueDate = dateKey(day.date);
    // Days before a replan were folded into the new schedule, so they are not listed again.
    day.tasks.filter(() => !rebase || dueDate >= rebase.date).forEach(({ course, lectureNumbers }) => {
      lectureNumbers.forEach(number => {
        const id = `lecture|${dueDate}|${course.id}|${number}`;
        const item = { id, type: 'lecture', number, date: day.date, course, subject: course.subject, title: course.title.replace(/^\[\d+\]\s*/, ''), minutes: 60 };
        const watchedOn = lectureWatchDates.get(`${course.id}|${number}`);
        if (!doneSets.get(course.id)?.has(number)) pending.push(item);
        else if (watchedOn && watchedOn > dueDate) done.push({ ...item, completedDate: watchedOn });
      });
    });
    if (day.missedWordMinutes > 0) {
      const id = `words|${dueDate}`;
      const item = { id, type: 'words', date: day.date, subject: '영어', title: '영단어 암기', minutes: day.missedWordMinutes };
      const completion = completed.get(id);
      (completion ? done : pending).push(completion ? { ...item, completedDate: completion.date } : item);
    }
  });
  return { pending, done };
}

function friendlyAuthError(error) {
  const message = error?.message || String(error);
  if (error?.code === 'over_email_send_rate_limit' || /email rate limit exceeded/i.test(message)) {
    return 'Supabase 기본 이메일 발송 한도(프로젝트당 시간당 2통)를 넘었어. 한 시간 정도 기다린 뒤 다시 시도하거나 Custom SMTP를 설정해줘.';
  }
  if (error?.code === 'over_request_rate_limit') {
    return '짧은 시간에 요청이 많았어. 몇 분 뒤 다시 시도해줘.';
  }
  return message;
}

function App() {
  const [data, setData] = useState(() => {
    const initial = addLocalIds(withDerivedProgress(load()));
    try { localStorage.setItem('pass-note', JSON.stringify(initial)); } catch { /* Keep the in-memory copy when storage is unavailable. */ }
    return initial;
  });
  const [tab, setTab] = useState(() => {
    try { const saved = localStorage.getItem('pass-note-tab'); return tabLabels.includes(saved) ? saved : '홈'; } catch { return '홈'; }
  });
  useEffect(() => { try { localStorage.setItem('pass-note-tab', tab); } catch { /* Remembering the tab is optional. */ } }, [tab]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [modal, setModal] = useState('');
  const [weekShift, setWeekShift] = useState(0);
  const [form, setForm] = useState({ subject: '영어', kind: '복습·문제풀이', minutes: 60, memo: '', courseId: '', lecture: '' });
  const [goalInput, setGoalInput] = useState('');
  const [examForm, setExamForm] = useState({ id: '', name: '', track: '일반행정', date: '' });
  const [goalNote, setGoalNote] = useState('');
  const [tripForm, setTripForm] = useState({ route: '', minutes: 10, note: '도보' });
  const [toast, setToast] = useState('');
  const [authUser, setAuthUser] = useState(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [authMessage, setAuthMessage] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [syncReady, setSyncReady] = useState(false);
  const [syncStatus, setSyncStatus] = useState(supabaseConfigured ? 'signed-out' : 'local-only');
  const authCallbackHandled = useRef(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  const changeCount = useRef(0);
  const pulling = useRef(false);
  const syncedRef = useRef(null);
  if (syncedRef.current === null) {
    try { syncedRef.current = new Set(JSON.parse(localStorage.getItem('pass-note-synced') || '[]')); } catch { syncedRef.current = new Set(); }
  }
  const markSynced = (sessions) => {
    syncedRef.current = new Set(sessions.map(session => session.localId || session.at));
    try { localStorage.setItem('pass-note-synced', JSON.stringify([...syncedRef.current])); } catch { /* Sync still works without the saved list. */ }
  };
  const save = (next, removedSessionIds = []) => {
    const normalized = addLocalIds(withDerivedProgress(next));
    changeCount.current += 1;
    setData(normalized);
    try { localStorage.setItem('pass-note', JSON.stringify(normalized)); } catch { /* Keep the in-memory copy when storage is unavailable. */ }
    if (supabase && authUser && syncReady) {
      setSyncStatus('syncing');
      writeRemoteData(supabase, authUser.id, normalized, removedSessionIds, syncedRef.current)
        .then(() => { markSynced(normalized.sessions); setSyncStatus('synced'); })
        .catch(error => { setSyncStatus('error'); setAuthMessage(`동기화에 실패했어: ${error.message}`); });
    }
  };

  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (active) setAuthUser(session?.user ?? null);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (active) setAuthUser(session?.user ?? null);
      if (active && event === 'PASSWORD_RECOVERY') { setAuthMode('set-password'); setTab('설정'); }
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!supabase || authCallbackHandled.current) return;
    const currentUrl = new URL(window.location.href);
    const tokenHash = currentUrl.searchParams.get('token_hash');
    const hashParams = new URLSearchParams(currentUrl.hash.slice(1));
    const authError = currentUrl.searchParams.get('error_description') || hashParams.get('error_description') || currentUrl.searchParams.get('error') || hashParams.get('error_code') || hashParams.get('error');
    if (authError) {
      authCallbackHandled.current = true;
      setAuthMessage(`이메일 로그인에 실패했어: ${authError}`);
      setTab('설정');
      window.history.replaceState({}, document.title, currentUrl.pathname);
      return;
    }
    if (!tokenHash) return;
    authCallbackHandled.current = true;
    setAuthMessage('이메일 링크를 확인하고 있어…');
    setTab('설정');
    const type = currentUrl.searchParams.get('type') || 'email';
    if (type === 'recovery') setAuthMode('set-password');
    supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      .then(({ data: result, error }) => {
        window.history.replaceState({}, document.title, currentUrl.pathname);
        if (error) {
          setAuthMessage(`로그인 링크를 확인하지 못했어: ${error.message}`);
          return;
        }
        if (result.user) setAuthUser(result.user);
        setAuthMessage('로그인됐어. 계정 기록을 불러오는 중이야.');
      })
      .catch(error => setAuthMessage(`로그인 링크를 확인하지 못했어: ${error.message}`));
  }, []);

  useEffect(() => {
    if (!supabase || !authUser) {
      setSyncReady(false);
      setSyncStatus(supabaseConfigured ? 'signed-out' : 'local-only');
      return undefined;
    }
    let active = true;
    setSyncReady(false);
    setSyncStatus('syncing');
    (async () => {
      try {
        const local = addLocalIds(load());
        const remote = await readRemoteData(supabase, authUser.id);
        remote.courses = remote.courses.filter(course => coreCourseIds.has(course.id));
        const merged = withDerivedProgress(reconcileStudyData(remote, local, syncedRef.current));
        localStorage.setItem('pass-note', JSON.stringify(merged));
        setData(merged);
        await writeRemoteData(supabase, authUser.id, merged, [], new Set(remote.sessions.map(session => session.localId)));
        markSynced(merged.sessions);
        if (active) { setSyncReady(true); setSyncStatus('synced'); setAuthMessage('이 기기의 기록을 계정과 동기화했어.'); }
      } catch (error) {
        if (active) { setSyncReady(false); setSyncStatus('error'); setAuthMessage(`연결에 실패했어: ${error.message} · Supabase SQL 적용 여부를 확인해줘.`); }
      }
    })();
    return () => { active = false; };
  }, [authUser?.id]);

  // Keep this device up to date with changes made on other devices.
  useEffect(() => {
    if (!supabase || !authUser || !syncReady) return undefined;
    let active = true;
    const pull = async () => {
      if (!active || pulling.current || document.visibilityState === 'hidden') return;
      pulling.current = true;
      const before = changeCount.current;
      try {
        const remote = await readRemoteData(supabase, authUser.id);
        remote.courses = remote.courses.filter(course => coreCourseIds.has(course.id));
        // Skip if the user saved something while we were reading; the next pull will catch up.
        if (!active || changeCount.current !== before) return;
        const local = dataRef.current;
        const merged = withDerivedProgress(reconcileStudyData(remote, local, syncedRef.current));
        const signature = (value) => value.sessions.map(session => session.localId).sort().join('|') + '#' + value.courses.map(course => `${course.id}:${course.completed}`).join(',');
        if (signature(merged) !== signature(local)) {
          // Keep the previous copy in case records were dropped by mistake.
          if (merged.sessions.length < local.sessions.length) { try { localStorage.setItem('pass-note-prev', JSON.stringify(local)); } catch { /* Optional safety copy. */ } }
          try { localStorage.setItem('pass-note', JSON.stringify(merged)); } catch { /* Keep the in-memory copy. */ }
          setData(merged);
        }
        const remoteIds = new Set(remote.sessions.map(session => session.localId));
        if (merged.sessions.some(session => Number(session.minutes) > 0 && !remoteIds.has(session.localId))) {
          await writeRemoteData(supabase, authUser.id, merged, [], remoteIds);
        }
        markSynced(merged.sessions);
        setSyncStatus('synced');
      } catch (error) {
        setSyncStatus('error');
        setAuthMessage(`다른 기기의 기록을 불러오지 못했어: ${error.message}`);
      } finally { pulling.current = false; }
    };
    const timer = setInterval(pull, 15000);
    window.addEventListener('focus', pull);
    document.addEventListener('visibilitychange', pull);
    window.addEventListener('online', pull);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', pull); document.removeEventListener('visibilitychange', pull); window.removeEventListener('online', pull); };
  }, [authUser?.id, syncReady]);

  const signInWithPassword = async (event) => {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true); setAuthMessage('');
    try {
      const { data: result, error } = await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword });
      if (error) setAuthMessage(`로그인하지 못했어: ${friendlyAuthError(error)}`);
      else if (result.user) { setAuthUser(result.user); setAuthMessage('로그인됐어. 기록을 불러오는 중이야.'); }
    } catch (error) {
      setAuthMessage(`로그인하지 못했어: ${friendlyAuthError(error)}`);
    } finally { setAuthBusy(false); }
  };
  const signUpWithPassword = async (event) => {
    event.preventDefault();
    if (!supabase) return;
    if (authPassword.length < 8) { setAuthMessage('비밀번호는 8자 이상으로 입력해줘.'); return; }
    if (authPassword !== confirmPassword) { setAuthMessage('비밀번호가 서로 달라. 다시 확인해줘.'); return; }
    setAuthBusy(true); setAuthMessage('');
    try {
      const { data: result, error } = await supabase.auth.signUp({ email: authEmail.trim(), password: authPassword, options: { emailRedirectTo: window.location.origin } });
      if (error) setAuthMessage(`가입하지 못했어: ${friendlyAuthError(error)}`);
      else if (result.session && result.user) { setAuthUser(result.user); setAuthMessage('가입과 로그인이 완료됐어.'); }
      else setAuthMessage('가입 요청을 보냈어. 이메일 확인 링크를 눌러 가입을 마쳐줘.');
    } catch (error) {
      setAuthMessage(`가입하지 못했어: ${friendlyAuthError(error)}`);
    } finally { setAuthBusy(false); }
  };
  const sendPasswordReset = async (event) => {
    event.preventDefault();
    if (!supabase || !authEmail.trim()) return;
    setAuthBusy(true); setAuthMessage('');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(authEmail.trim(), { redirectTo: window.location.origin });
      setAuthMessage(error ? `재설정 메일을 보내지 못했어: ${friendlyAuthError(error)}` : '비밀번호 재설정 메일을 보냈어. 메일의 링크를 열어 새 비밀번호를 설정해줘.');
    } catch (error) {
      setAuthMessage(`재설정 메일을 보내지 못했어: ${friendlyAuthError(error)}`);
    } finally { setAuthBusy(false); }
  };
  const updatePassword = async (event) => {
    event.preventDefault();
    if (!supabase) return;
    if (authPassword.length < 8) { setAuthMessage('비밀번호는 8자 이상으로 입력해줘.'); return; }
    if (authPassword !== confirmPassword) { setAuthMessage('비밀번호가 서로 달라. 다시 확인해줘.'); return; }
    setAuthBusy(true); setAuthMessage('');
    try {
      const { error } = await supabase.auth.updateUser({ password: authPassword });
      if (error) setAuthMessage(`비밀번호를 바꾸지 못했어: ${friendlyAuthError(error)}`);
      else { setAuthMode('login'); setAuthPassword(''); setConfirmPassword(''); setAuthMessage('비밀번호를 설정했어. 이제 이메일과 비밀번호로 로그인하면 돼.'); }
    } catch (error) {
      setAuthMessage(`비밀번호를 바꾸지 못했어: ${friendlyAuthError(error)}`);
    } finally { setAuthBusy(false); }
  };
  const signOut = async () => { await supabase?.auth.signOut(); setAuthMessage('로그아웃했어. 기록은 이 기기에 남아 있어.'); };
  const hasCustomExams = data.sessions.some(s => s.kind === '시험');
  const examList = hasCustomExams
    ? data.sessions.filter(s => s.kind === '시험').sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0)).map(parseExam).filter(Boolean)
    : defaultExams;
  const nearest = nearestExam(examList);
  const sessionsToday = data.sessions.filter((s) => s.date === todayKey() && !isPseudoSession(s));
  const extraSessionsToday = sessionsToday.filter(s => String(s.memo || '').startsWith('[extra]')).sort(newestFirst);
  const savedMemos = [
    ...data.sessions.filter(s => s.kind === '메모').map(s => ({ key: s.at, date: s.date, text: cleanMemo(s.memo), at: s.at })),
    ...Object.entries(data.dailyGoals || {}).filter(([, v]) => v?.note).map(([date, v]) => ({ key: `legacy-${date}`, date, text: v.note, legacy: true })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 30);
  const todayGoals = data.dailyGoals?.[todayKey()] || { tasks: [], note: '' };
  const todayMinutes = sessionsToday.filter(s => !isCatchupSession(s)).reduce((a, s) => a + Number(s.minutes), 0);
  const courseCompleted = data.courses.reduce((sum,c)=>sum+Number(c.completed),0);
  const courseTotal = data.courses.reduce((sum,c)=>sum+Number(c.total),0);
  const lecturePlan = useMemo(() => buildLecturePlan(data.courses, data.sessions), [data.courses, data.sessions]);
  const studyBacklog = useMemo(() => buildStudyBacklog(lecturePlan, data.sessions, data.courses), [lecturePlan, data.sessions, data.courses]);
  const lectureDone = useMemo(() => lectureDoneSets(data.courses, data.sessions), [data.courses, data.sessions]);
  const isLectureDone = (courseId, number) => lectureDone.get(courseId)?.has(number) || false;
  const todayPlan = lecturePlan.find(day => dateKey(day.date) === todayKey());
  const futureLectureDays = lecturePlan.filter(day => dateKey(day.date) >= todayKey()).length;
  const todayActualLectures = sessionsToday.filter(session => session.courseId && session.kind === '인강 시청' && !isCatchupSession(session)).length;
  const todayActualWords = sessionsToday.filter(session => session.kind === '단어 암기' && !String(session.memo || '').startsWith('[catchup:')).reduce((sum, session) => sum + Number(session.minutes), 0);
  const todayUnfinishedLectures = todayPlan ? todayPlan.tasks.reduce((sum, { course, lectureNumbers }) => sum + lectureNumbers.filter(n => !isLectureDone(course.id, n)).length, 0) : 0;
  const todayUnfinishedMinutes = todayPlan ? todayUnfinishedLectures * 60 + Math.max(0, todayPlan.wordMinutes - todayActualWords) : 0;
  const todayActualLecturesByCourse = Object.fromEntries(data.courses.map(course => [course.id, sessionsToday.filter(session => session.courseId === course.id && session.kind === '인강 시청').length]));
  const todayGoalLectureTasks = (todayPlan?.tasks || []).flatMap(({ course, count, lectureNumbers = [] }) => Array.from({ length: count }, (_, index) => ({ course, lectureNumber: lectureNumbers[index] || Number(course.completed) - todayActualLecturesByCourse[course.id] + index + 1, key: `lecture:${course.id}:${lectureNumbers[index] || index + 1}` })));
  const todayGoalCompleted = todayGoalLectureTasks.reduce((sum, task) => sum + (isLectureDone(task.course.id, task.lectureNumber) ? 1 : 0), 0) + (todayGoals.tasks || []).filter(task => task.done).length;
  const todayGoalTotal = todayGoalLectureTasks.length + (todayGoals.tasks || []).length;
  const wordPlanMinutes = todayPlan?.wordMinutes ?? 60;
  const todayWordsDone = todayActualWords >= wordPlanMinutes;
  const todayStudyTotal = todayGoalLectureTasks.length + 1;
  const todayStudyDone = todayGoalLectureTasks.filter(task => isLectureDone(task.course.id, task.lectureNumber)).length + (todayWordsDone ? 1 : 0);  const weekStart = useMemo(() => { const d = studyDate(weekShift * 7); d.setDate(d.getDate() - (d.getDay() + 6) % 7); d.setHours(0, 0, 0, 0); return d; }, [weekShift]);
  const weekDates = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; });
  const weekSessions = data.sessions.filter((s) => !isPseudoSession(s) && s.date >= dateKey(weekDates[0]) && s.date <= dateKey(weekDates[6])).sort(newestFirst);
  const weekMinutes = weekSessions.reduce((a, s) => a + Number(s.minutes), 0);
  const weekTargetHours = weekDates.reduce((sum, d) => sum + dayTarget(d, lecturePlan), 0);
  const weekTargetMinutes = weekTargetHours * 60;
  const formCourse = data.courses.find(course => course.id === form.courseId) || data.courses[0];
  const formLectureOptions = formCourse ? Array.from({ length: Number(formCourse.total) }, (_, i) => i + 1).filter(n => !isLectureDone(formCourse.id, n)) : [];
  const formLecture = formLectureOptions.includes(Number(form.lecture)) ? Number(form.lecture) : formLectureOptions[0];
  const addSession = (e) => {
    e.preventDefault();
    const { courseId, lecture, ...rest } = form;
    if (form.kind === '인강 시청') {
      if (!formCourse || !formLecture) { setToast('기록할 과정과 강의 번호를 골라줘'); setTimeout(() => setToast(''), 2400); return; }
      const extra = form.memo.trim() ? ` · ${form.memo.trim()}` : '';
      const session = { subject: formCourse.subject, kind: '인강 시청', courseId: formCourse.id, minutes: Number(form.minutes), memo: `[extra][lec:${formLecture}] ${formCourse.title} · ${formLecture}강 수강 완료${extra}`, date: todayKey(), at: new Date().toISOString() };
      save({ ...data, courses: data.courses.map(c => c.id === formCourse.id ? { ...c, completed: Number(c.completed) + 1 } : c), sessions: [session, ...data.sessions] });
      setForm({ ...form, memo: '', lecture: '' });
      setModal(''); setToast(`${formCourse.subject} ${formLecture}강 수료로 기록했어요`); setTimeout(() => setToast(''), 2400);
      return;
    }
    save({ ...data, sessions: [{ ...rest, memo: `[extra] ${form.memo || ''}`.trim(), minutes: Number(form.minutes), date: todayKey(), at: new Date().toISOString() }, ...data.sessions] });
    setModal(''); setToast('공부 기록을 저장했어요'); setTimeout(() => setToast(''), 2400);
  };
  const addTrip = (e) => { e.preventDefault(); save({ ...data, trips: [...data.trips, { ...tripForm, minutes: Number(tripForm.minutes) }] }); setTripForm({ route: '', minutes: 10, note: '도보' }); setModal(''); };
  const addDailyGoal = (e) => {
    e.preventDefault();
    const title = goalInput.trim();
    if (!title) return;
    const dailyGoals = {
      ...(data.dailyGoals || {}),
      [todayKey()]: { ...todayGoals, tasks: [...(todayGoals.tasks || []), { id: `${Date.now()}`, title, done: false }] },
    };
    save({ ...data, dailyGoals });
    setGoalInput('');
  };
  const toggleDailyGoal = (id) => {
    const dailyGoals = {
      ...(data.dailyGoals || {}),
      [todayKey()]: { ...todayGoals, tasks: (todayGoals.tasks || []).map(task => task.id === id ? { ...task, done: !task.done } : task) },
    };
    save({ ...data, dailyGoals });
  };
  // Memos are stored as 1-minute placeholder sessions (the database requires minutes > 0, and they are excluded from study totals) so they sync to every device like other records.
  const saveDailyGoalNote = () => {
    const text = goalNote.trim();
    if (!text) return;
    const session = { subject: '메모', kind: '메모', minutes: 1, memo: text, date: todayKey(), at: new Date().toISOString() };
    save({ ...data, sessions: [session, ...data.sessions] });
    setGoalNote('');
    setToast('메모를 저장했어');
    setTimeout(() => setToast(''), 2200);
  };
  const deleteMemo = (memo) => {
    if (memo.legacy) {
      save({ ...data, dailyGoals: { ...(data.dailyGoals || {}), [memo.date]: { ...data.dailyGoals[memo.date], note: '' } } });
      return;
    }
    const removed = data.sessions.find(s => s.at === memo.at);
    save({ ...data, sessions: data.sessions.filter(s => s.at !== memo.at) }, removed ? [removed.localId || removed.at] : []);
  };
  const completeLecture = (course, number) => {
    if (!course) return;
    const doneSet = lectureDone.get(course.id) || new Set();
    const lectureNumber = number || nextUndoneLecture(course, doneSet);
    if (!lectureNumber || doneSet.has(lectureNumber) || Number(course.completed) >= Number(course.total)) return;
    const nextCourse = { ...course, completed: Number(course.completed) + 1 };
    const pastItem = studyBacklog.pending.find(item => item.type === 'lecture' && item.course.id === course.id && item.number === lectureNumber);
    const memo = `${pastItem ? '[catchup]' : ''}[lec:${lectureNumber}] ${course.title} · ${lectureNumber}강 수강 완료${pastItem ? ' (미완료분 보충)' : ''}`;
    const session = { subject: course.subject, kind: '인강 시청', courseId: course.id, minutes: 60, memo, date: todayKey(), at: new Date().toISOString() };
    save({ ...data, courses: data.courses.map(c => c.id === course.id ? nextCourse : c), sessions: [session, ...data.sessions] });
    setToast(pastItem ? `${course.title} ${lectureNumber}강 보충 완료 · 1시간 기록` : `${course.title} ${lectureNumber}강 완료 · 1시간 기록`);
    setTimeout(() => setToast(''), 2600);
  };
  const recordCatchup = (item) => {
    if (item.type === 'lecture') {
      completeLecture(data.courses.find(entry => entry.id === item.course.id), item.number);
      return;
    }
    const at = new Date().toISOString();
    const marker = `[catchup:${item.id}]`;
    const session = { subject: '영어', kind: '단어 암기', minutes: item.minutes, memo: `${marker} ${new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(item.date)} 미완료분 보충`, date: todayKey(), at };
    save({ ...data, sessions: [session, ...data.sessions] });
    setToast(`영단어 ${fmtMinutes(item.minutes)} 보충 완료로 기록했어`);
    setTimeout(() => setToast(''), 2600);
  };
  const completeWords = () => {
    const minutes = wordPlanMinutes - todayActualWords;
    if (minutes <= 0) return;
    const session = { subject: '영어', kind: '단어 암기', minutes, memo: '영단어 암기 완료', date: todayKey(), at: new Date().toISOString() };
    save({ ...data, sessions: [session, ...data.sessions] });
    setToast(`영단어 ${fmtMinutes(minutes)} 완료로 기록했어`);
    setTimeout(() => setToast(''), 2600);
  };  const removeSessions = (ats) => {
    const removed = data.sessions.filter(session => ats.includes(session.at));
    if (!removed.length) return false;
    save({ ...data, sessions: data.sessions.filter(session => !ats.includes(session.at)) }, removed.map(session => session.localId || session.at));
    return true;
  };
  const undoLecture = (course, number) => {
    const own = data.sessions.filter(session => session.courseId === course.id && session.kind === '인강 시청');
    const numbered = own.filter(session => Number((String(session.memo || '').match(lectureMarkerPattern) || [])[1]) === number).sort(newestFirst)[0];
    const todayUnnumbered = own.filter(session => session.date === todayKey() && !lectureMarkerPattern.test(String(session.memo || ''))).sort(newestFirst)[0];
    const target = numbered || todayUnnumbered;
    if (target && removeSessions([target.at])) setToast(`${course.subject} ${number}강 완료를 취소했어`);
    else setToast('이전에 끝낸 강의라 여기서는 취소할 수 없어');
    setTimeout(() => setToast(''), 2600);
  };
  const undoWords = () => {
    let total = todayActualWords;
    const removeAts = [];
    for (const session of sessionsToday.filter(s => s.kind === '단어 암기' && !String(s.memo || '').startsWith('[catchup:')).sort(newestFirst)) {
      if (total < wordPlanMinutes) break;
      removeAts.push(session.at);
      total -= Number(session.minutes);
    }
    if (removeSessions(removeAts)) setToast('영단어 완료를 취소했어');
    setTimeout(() => setToast(''), 2600);
  };  // Rewrites the whole exam list (delete old placeholder sessions, create the new ones).
  const commitExams = (nextList) => {
    const old = data.sessions.filter(s => s.kind === '시험');
    const base = Date.now();
    const created = (nextList.length ? nextList : [{ empty: true, name: '(없음)' }]).map((exam, index) => ({
      subject: '시험', kind: '시험', minutes: 1, memo: JSON.stringify(exam), date: todayKey(), at: new Date(base + index).toISOString(),
    }));
    save({ ...data, sessions: [...created, ...data.sessions.filter(s => s.kind !== '시험')] }, old.map(s => s.localId || s.at));
  };
  const saveExam = (event) => {
    event.preventDefault();
    const name = examForm.name.trim();
    if (!name) return;
    const entry = { id: examForm.id || `exam-${Date.now()}`, name, track: examForm.track.trim(), date: examForm.date || null, short: examForm.id ? (examList.find(e => e.id === examForm.id)?.short || '') : '' };
    commitExams(examForm.id ? examList.map(e => e.id === entry.id ? entry : e) : [...examList, entry]);
    setModal('');
    setToast(examForm.id ? '시험 정보를 수정했어요' : '시험을 추가했어요');
    setTimeout(() => setToast(''), 2400);
  };
  const deleteExam = (exam) => { commitExams(examList.filter(e => e.id !== exam.id)); };
  const openExamForm = (exam) => { setExamForm(exam ? { id: exam.id, name: exam.name, track: exam.track || '', date: exam.date || '' } : { id: '', name: '', track: '일반행정', date: '' }); setModal('exam'); };
  // Restore records from a backup file (설정 > 기록 백업 다운로드). Only records this device
  // does not have yet are added, then they are uploaded again.
  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = Array.isArray(parsed.sessions) ? parsed.sessions.filter(s => s && s.date && s.kind && Number(s.minutes) > 0) : [];
      const have = new Set(data.sessions.map(s => s.localId || s.at));
      const fresh = incoming.map(s => ({ ...s, localId: s.localId || s.at })).filter(s => !have.has(s.localId));
      const freshIds = new Set(fresh.map(s => s.localId));
      syncedRef.current = new Set([...syncedRef.current].filter(id => !freshIds.has(id)));
      save({ ...data, sessions: [...data.sessions, ...fresh], dailyGoals: { ...(parsed.dailyGoals || {}), ...(data.dailyGoals || {}) } });
      setToast(fresh.length ? `백업에서 기록 ${fresh.length}개를 불러왔어요` : '새로 불러올 기록이 없어요 (이미 모두 있어요)');
    } catch {
      setToast('백업 파일을 읽지 못했어요');
    }
    setTimeout(() => setToast(''), 3200);
  };
  const activeRebase = latestRebase(data.sessions);
  const startReplan = (skipToday = false) => {
    const from = skipToday ? dateKey(studyDate(1)) : todayKey();
    const startText = skipToday ? '오늘은 영단어만 남기고 내일부터' : '오늘부터';
    if (!window.confirm(`${startText} 12월 8일까지, 아직 못 들은 모든 강의(미완료 포함)를 날짜별로 다시 나눌까요?\n알바가 있는 날(월~수 저녁, 11/20 오후)은 강의를 적게 배정해요. 지난 날짜의 미완료 강의는 새 일정에 포함돼요.`)) return;
    const at = new Date().toISOString();
    const session = { subject: '계획', kind: '계획', minutes: 1, memo: JSON.stringify({ date: todayKey(), from, at }), date: todayKey(), at };
    const old = data.sessions.filter(s => s.kind === '계획');
    save({ ...data, sessions: [session, ...data.sessions.filter(s => s.kind !== '계획')] }, old.map(s => s.localId || s.at));
    setToast('남은 양을 기준으로 일정을 다시 만들었어요');
    setTimeout(() => setToast(''), 2600);
  };
  const undoReplan = () => {
    const old = data.sessions.filter(s => s.kind === '계획');
    if (!old.length) return;
    save({ ...data, sessions: data.sessions.filter(s => s.kind !== '계획') }, old.map(s => s.localId || s.at));
    setToast('원래 일정으로 되돌렸어요');
    setTimeout(() => setToast(''), 2600);
  };
  const removeSession = (at) => { const removed = data.sessions.find((s) => s.at === at); const courses = removed?.courseId ? data.courses.map(c => c.id === removed.courseId ? { ...c, completed: Math.max(0, c.completed - 1) } : c) : data.courses; save({ ...data, courses, sessions: data.sessions.filter((s) => s.at !== at) }, removed ? [removed.localId || removed.at] : []); };
  const menu = [{ label: '홈', icon: Home }, { label: '오늘의 시간표', icon: CalendarDays }, { label: '일정', icon: CalendarDays }, { label: '공부 기록', icon: Clock3 }, { label: '학습 통계 및 진도', icon: ChartNoAxesColumn }, { label: '설정', icon: Settings2 }];
  return <div className="app-shell">
    <aside className={mobileMenuOpen?"sidebar is-open":"sidebar"}><div className="brand"><button className="brand-home" onClick={()=>{setTab('홈');setMobileMenuOpen(false)}} aria-label="합격 기록장 홈으로"><div className="brand-mark"><Sparkles size={18}/></div><div><strong>합격 기록장</strong><span>MY STUDY JOURNAL</span></div></button><button className="sidebar-close icon-button" onClick={()=>setMobileMenuOpen(false)} aria-label="사이드 메뉴 닫기"><X size={17}/></button></div><div className="profile-card"><div><b>목표 시험</b><small>{nearest?`${nearest.short||nearest.name}${nearest.track?` ${nearest.track}`:''} · ${ddayLabel(nearest.date)}`:'시험을 추가해줘'}</small></div><ChevronRight size={16} className="muted"/></div><div className="side-label">MENU</div><nav>{menu.map(({label, icon: Icon}) => <button key={label} className={`nav-item ${tab === label ? 'active' : ''}`} onClick={() => {setTab(label);setMobileMenuOpen(false)}}><Icon size={18}/>{label}{label === '홈' && <span className="nav-dot"/>}</button>)}</nav><div className="side-label plan-label">MY GOAL</div><div className="goal-mini"><div className="goal-line"><Target size={17}/><b>주간 목표</b></div><strong>{fmtHours(weekTargetHours)}<span>시간</span></strong><div className="mini-track"><i style={{width:`${Math.min(weekTargetMinutes ? weekMinutes / weekTargetMinutes * 100 : 0,100)}%`}}/></div><small>{fmt(weekMinutes)} 달성</small></div><div className="sidebar-bottom"><div className="sync-state"><i/> {syncStatus==='synced'?'Supabase 동기화됨':syncStatus==='syncing'?'동기화 중':syncStatus==='error'?'동기화 확인 필요':supabaseConfigured?'로그인 후 동기화':'이 기기에 자동 저장'}</div></div></aside>
    <main className="main"><header className="topbar"><div className="header-brand-group"><button className="header-brand" onClick={()=>setMobileMenuOpen(!mobileMenuOpen)} aria-label={mobileMenuOpen?"메뉴 닫기":"메뉴 열기"} aria-expanded={mobileMenuOpen}><Sparkles size={17}/> 합격 기록장</button></div><div className="crumb">나의 학습 <span>/</span> <b>{tab}</b></div><div className="top-right"><button className={`sync-pill ${syncStatus}`} onClick={()=>setTab('설정')}><span className="sync-pill-icon">{syncStatus==='synced'?<Cloud size={15}/>:<CloudOff size={15}/>}</span>{syncStatus==='synced'?'동기화됨':syncStatus==='syncing'?'연결 중':syncStatus==='error'?'연결 확인':supabaseConfigured?'로그인 필요':'기기 저장'}</button><span className="date-pill"><CalendarDays size={15}/>{new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric',weekday:'short'}).format(new Date())}</span></div></header>
      <div className="content">{tab === '홈' && <>
<section className="welcome"><div><div className="eyebrow">{new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric'}).format(new Date()).toUpperCase()} · MY STUDY PLAN</div><h1>오늘도 한 걸음,<br/><em>합격에 가까워지고 있어요.</em></h1><p>꾸준히 쌓는 오늘의 공부가 내일의 실력이 됩니다.</p></div><div className="welcome-stamp"><span>2027</span><b>합격을 향해</b><small>{nearest?`${nearest.short||nearest.name} ${ddayLabel(nearest.date)}`:'ONE DAY AT A TIME'}</small></div></section>
<section className="stat-grid"><div className="stat-card primary-stat"><div className="stat-head"><span>오늘 순공부</span><Clock3 size={17}/></div><div className="stat-value">{(todayMinutes/60).toFixed(todayMinutes%60?1:0)}<small>시간</small></div><div className="stat-foot"><span className="green-chip">목표 {fmtHours(dayTarget(new Date(),lecturePlan))}시간</span><span>{Math.min(Math.round(todayMinutes/Math.max(dayTarget(new Date(),lecturePlan)*60,1)*100),100)}% 달성</span></div><div className="progress"><i style={{width:`${Math.min(todayMinutes/Math.max(dayTarget(new Date(),lecturePlan)*60,1)*100,100)}%`}}/></div></div><div className="stat-card"><div className="stat-head"><span>이번 주 순공부</span><Target size={17}/></div><div className="stat-value">{(weekMinutes/60).toFixed(weekMinutes%60?1:0)}<small>시간</small><b className="of-total">/ {fmtHours(weekTargetHours)}시간</b></div><div className="stat-foot"><span>목표까지</span><b>{fmt(Math.max(weekTargetMinutes-weekMinutes,0))}</b></div><div className="progress"><i className="blue-fill" style={{width:`${Math.min(weekTargetMinutes?weekMinutes/weekTargetMinutes*100:0,100)}%`}}/></div></div><div className="stat-card"><div className="stat-head"><span>이번 주 기록</span><BookOpen size={17}/></div><div className="stat-value">{weekSessions.length}<small>회</small></div><div className="stat-foot"><span>가장 많이 공부한 과목</span><b>{topSubject(weekSessions)}</b></div></div></section>
<div className="shift-notice"><BriefcaseBusiness size={16}/><span><b>11월 근무 일정</b> · 12일·13일 20:00–24:00 추가 근무 · 20일 16:00–20:00</span></div>
<details className="panel home-progress-panel" open><summary className="panel-heading"><div><div className="eyebrow">SUBJECT BALANCE</div><h2>과목별 학습 현황</h2></div></summary><div className="subject-list">{data.courses.map((course,i)=>{const pct=Math.round(course.completed/course.total*100);return <div className="subject-row" key={course.id}><span className={`subject-icon color-${i}`}>{course.subject==='영어'?'A':course.subject.slice(0,1)}</span><b>{course.subject}</b><div className="subject-bar"><i style={{width:`${pct}%`}}/></div><small>{course.completed}/{course.total}강</small></div>})}</div></details>
<section className="home-shortcuts"><button className="panel" onClick={()=>setTab('오늘의 시간표')}><CalendarDays size={20}/><b>오늘의 시간표</b><small>{todayPlan?.goal||0}강 배정 · 강의별 번호와 완료 체크</small></button><button className="panel" onClick={()=>setTab('일정')}><CalendarDays size={20}/><b>일정</b><small>주간 일정과 기본이론 완강 일정</small></button><button className="panel" onClick={()=>setTab('공부 기록')}><Clock3 size={20}/><b>공부 기록</b><small>공부 시간, 미완료·추가 공부 기록</small></button><button className="panel" onClick={()=>setTab('학습 통계 및 진도')}><ChartNoAxesColumn size={20}/><b>학습 통계 및 진도</b><small>{courseCompleted}/{courseTotal}강 완료</small></button></section>
</>}
{tab === '오늘의 시간표' && <>
<div className="page-title"><div className="eyebrow">TODAY'S TIMETABLE</div><h1>오늘의 시간표</h1><p>실제 수강할 과목과 강의 번호를 확인하고, 완료하면 바로 체크해줘.</p></div>
<section className="panel today-timetable-panel"><div className="panel-heading"><div><div className="eyebrow">TODAY'S PLAN</div><h2>시간대별 일정</h2></div><span className="record-count">{todayPlan?.goal||0}강 계획</span></div><div className="schedule-list">{todaySchedule(new Date(),lecturePlan).map((item,i)=><div className={`schedule-row ${item.type}`} key={i}><div className="time-col">{item.time}</div><div className="timeline"><i/></div><div className="schedule-info"><div className="schedule-title">{item.title}</div><small>{item.sub}</small></div>{item.type==='work'?<BriefcaseBusiness size={16}/>:item.type==='study'?<span className="subject-pill">{item.subject}</span>:<Coffee size={16}/>}</div>)}</div></section>
<section className="panel today-lecture-check-panel"><div className="panel-heading"><div><div className="eyebrow">TODAY'S STUDY</div><h2>오늘 해야 할 학습</h2></div><span className="record-count">{todayStudyDone}/{todayStudyTotal} 완료</span></div><div className="daily-goal-progress"><i style={{width:`${todayStudyTotal?todayStudyDone/todayStudyTotal*100:0}%`}}/></div><p className="daily-goal-help">완료를 누르면 실제 진도와 공부 기록에 바로 반영되고, 완료한 항목을 다시 누르면 취소돼. 못 한 학습은 내일 일정을 바꾸지 않고 공부 기록의 미완료 공부에 쌓여.</p><div className="daily-goal-list"><button type="button" className={`daily-goal-item ${todayWordsDone?'done':''}`} onClick={todayWordsDone?undoWords:completeWords}><span className="daily-goal-check">{todayWordsDone&&<Check size={15}/>}</span><span><b>영어 · 영단어 암기</b><small>{fmtMinutes(wordPlanMinutes)}{todayActualWords>0&&!todayWordsDone?` · ${fmtMinutes(todayActualWords)} 기록됨`:''}</small></span></button>{todayGoalLectureTasks.map(task=>{const checked=isLectureDone(task.course.id,task.lectureNumber);return <button type="button" className={`daily-goal-item ${checked?'done':''}`} key={task.key} onClick={()=>{const course=data.courses.find(c=>c.id===task.course.id);checked?undoLecture(course,task.lectureNumber):completeLecture(course,task.lectureNumber)}}><span className="daily-goal-check">{checked&&<Check size={15}/>}</span><span><b>{task.course.subject} · {task.lectureNumber}강</b><small>{task.course.title.replace(/^\[\d+\]\s*/, '')}</small></span></button>})}</div></section>
</>}
{tab === '일정' && <>
<div className="page-title"><div className="eyebrow">SCHEDULE</div><h1>일정</h1><p>이번 주 일정과 강의 번호, 기본이론 완강 일정을 한눈에 확인해.</p></div>
<section className="panel replan-panel"><div className="panel-heading"><div><div className="eyebrow">REPLAN</div><h2>남은 양으로 일정 다시 만들기</h2></div>{activeRebase&&<span className="record-count">{activeRebase.date.slice(5).replace('-','/')}부터 적용 중</span>}</div><p className="daily-goal-help">일정이 많이 밀렸을 때 쓰는 기능이야. 아직 못 들은 강의 전체(미완료 포함)를 12월 8일까지 날짜별로 다시 나누고, 알바가 있는 날(월~수 저녁, 11/20 오후)은 강의를 적게 배정해. 다시 만든 뒤에는 못 들어도 다음 날로 밀리지 않고 미완료 목록에 쌓여. 영단어는 매일 1시간 그대로야.</p><div className="replan-actions"><button className="primary-button" type="button" onClick={()=>startReplan(true)}>오늘은 영단어만 · 내일부터 다시 만들기</button><button className="export-button" type="button" onClick={()=>startReplan(false)}>오늘부터 다시 만들기</button>{activeRebase&&<button className="export-button" type="button" onClick={undoReplan}>원래 일정으로 되돌리기</button>}</div></section>

<div className="week-switch"><button className="icon-button" onClick={()=>setWeekShift(weekShift-1)}><ChevronLeft size={18}/></button><b>{new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[0])} – {new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[6])}</b><button className="icon-button" onClick={()=>setWeekShift(weekShift+1)}><ChevronRight size={18}/></button><button className="today-button" onClick={()=>setWeekShift(0)}>이번 주</button></div><section className="weekly-agenda-grid">{weekDates.map((d,i)=>{const date=dateKey(d);const goal=dayTarget(d,lecturePlan);const mins=weekSessions.filter(item=>item.date===date).reduce((sum,item)=>sum+Number(item.minutes),0);const items=todaySchedule(d,lecturePlan);const planDay=lecturePlan.find(day=>dateKey(day.date)===date);const brief=planDay?planDay.tasks.map(({course,lectureNumbers})=>`${course.subject} ${lectureNumbers.length>1?`${lectureNumbers[0]}–${lectureNumbers[lectureNumbers.length-1]}`:lectureNumbers[0]}강`).join(" · "):"";return <details className="panel weekly-day-card" key={date} open={date===todayKey()}><summary className="weekly-day-header"><div><div className="weekly-day-title"><b>{weekdays[i]} {d.getDate()}일</b>{date===todayKey()&&<i>오늘</i>}</div><small>{brief||`${items.filter(item=>item.type==='study').length}개 학습 블록`}</small></div><strong>{fmtHours(goal)}<small>시간</small></strong></summary><div className="weekly-day-progress"><i style={{width:`${Math.min(goal?mins/(goal*60)*100:0,100)}%`}}/></div><div className="weekly-agenda-list">{items.map((item,index)=><div className={`weekly-agenda-row ${item.type}`} key={`${item.time}-${index}`}><time>{item.time}</time><div><b>{item.title}</b><small>{item.sub}</small></div></div>)}</div></details>})}</section>
<details className="panel lecture-plan-panel compact-lecture-plan"><summary className="lecture-plan-summary"><div className="lecture-plan-head"><div><div className="eyebrow">NOV 11 – DEC 8</div><h2>기본이론 완강 일정</h2><p>남은 {courseTotal-courseCompleted}강 · 종료일은 12월 8일로 유지하고, 계획은 날짜대로 진행되고, 못 들은 강의는 미완료 목록에 남아.</p></div><span className="lecture-plan-total">11/12·13 근무 · 11/20 6강</span></div></summary><div className="lecture-plan-list">{lecturePlan.map(day=>{const key=dateKey(day.date);return <article className="lecture-plan-day" key={key}><div className="lecture-plan-date"><b>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',weekday:'short'}).format(day.date)}</b><span>{day.goal}강 <i>· 단어 {fmtMinutes(day.wordMinutes)}</i></span></div><div className="lecture-plan-tasks">{day.tasks.map(({course,count})=><span key={course.id}><b>{course.subject}</b>{course.title.replace(/^\[\d+\]\s*/, '')} · {count}강</span>)}</div>{key<todayKey()&&<div className="lecture-plan-status missed"><b>실제 {day.actualLectures}강 완료</b><span>미완료 {day.missedLectures}강 · 단어 {fmtMinutes(day.missedWordMinutes)}</span></div>}{key===todayKey()&&<div className="lecture-plan-status"><b>실제 {day.actualLectures}/{day.goal}강 · {fmt(day.actualMinutes)}</b><span>오늘 남은 강의 {todayUnfinishedLectures}강</span></div>}{key>todayKey()&&day.recoveryLectures>0&&<div className="lecture-plan-status recovery">미완료 강의 보충 +{day.recoveryLectures}강</div>}{key>todayKey()&&day.wordRecoveryMinutes>0&&<div className="lecture-plan-status recovery">단어 미완료 {day.wordRecoveryMinutes}분 보충</div>}{(key==='2026-11-20'||key==='2026-11-12'||key==='2026-11-13'||(day.date.getDay()>=1&&day.date.getDay()<=3))&&<div className="lecture-plan-work"><BriefcaseBusiness size={14}/>{key==='2026-11-20'?'추가 근무 16:00–20:00':'편의점 근무 20:00–24:00'}</div>}</article>})}</div><p className="lecture-plan-note">11월 11일 목표는 영어 2강·행정학 1강이야. 11월 12일부터 날짜별 배정량대로 진행하고(미완료분은 다음 날로 밀지 않아), 매일 단어 1시간을 포함해. 11월 12·13일은 20:00–24:00 근무를 반영했어. 12월 9–10일 예비군은 완강 일정 종료 이후라 배정하지 않아.</p></details>
</>}
{tab === '공부 기록' && <><div className="page-title page-title-row"><div><div className="eyebrow">STUDY LOG</div><h1>공부 기록</h1><p>강의 시청과 복습·문제풀이 시간을 구분해 기록해요.</p></div><button className="primary-button" onClick={()=>setModal('session')}><Plus size={17}/> 기록 추가</button></div><section className="panel study-plan-status"><div><span>오늘 계획</span><b>{todayPlan?.goal ?? 0}강 · 단어 {fmtMinutes(todayPlan?.wordMinutes ?? 0)}</b></div><div><span>실제 완료</span><b>{todayActualLectures}강 · {fmt(todayMinutes)}</b></div><p>미완료 {todayUnfinishedLectures}강 · {fmt(todayUnfinishedMinutes)} 은 내일로 밀리지 않고, 아래 미완료 공부 목록에 쌓여.</p></section><section className="panel catchup-panel"><div className="panel-heading"><div><div className="eyebrow">CATCH-UP LIST</div><h2>미완료 공부</h2></div><span className="record-count">{studyBacklog.pending.length}개 남음</span></div><p className="catchup-intro">하루가 지나면 못한 강의와 영단어가 여기에 쌓여. 실제로 보충한 뒤 완료 기록을 눌러 체크해줘.</p>{studyBacklog.pending.length?<div className="catchup-list">{studyBacklog.pending.map(item=><article className="catchup-item" key={item.id}><div className={`catchup-icon ${item.type}`}>{item.type==='lecture'?<BookOpen size={17}/>:<Clock3 size={17}/>}</div><div className="catchup-copy"><b>{item.title}</b><span>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',weekday:'short'}).format(item.date)} · {item.type==='lecture'?`${item.number}강 · 약 1시간`:`단어 ${fmtMinutes(item.minutes)}`}</span></div><button className="catchup-complete" onClick={()=>recordCatchup(item)}>보충 완료</button></article>)}</div>:<div className="catchup-empty"><Check size={17}/><span>밀린 공부가 없어. 오늘 계획을 이어가자!</span></div>}{studyBacklog.done.length>0&&<details className="catchup-history"><summary>완료한 보충 {studyBacklog.done.length}건 보기</summary><div className="catchup-list">{studyBacklog.done.slice().reverse().map(item=><article className="catchup-item done" key={item.id}><div className="catchup-icon"><Check size={16}/></div><div className="catchup-copy"><b>{item.title}</b><span>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(item.date)} 미완료 · {new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(new Date(item.completedDate+'T00:00:00'))} 보충 완료</span></div><Check size={17}/></article>)}</div></details>}</section><section className="panel daily-goals-panel"><div className="panel-heading"><div><div className="eyebrow">EXTRA STUDY</div><h2>추가 공부 기록</h2></div><button className="primary-button" onClick={()=>setModal('session')}><Plus size={17}/> 추가 공부 기록하기</button></div><p className="daily-goal-help">계획 밖에서 공부한 내용을 과목과 학습 종류별로 기록해. 인강 시청을 고르면 강의 번호까지 진도에 반영돼서, 미리 들은 강의는 이후 일정에서 빠져. 계획 강의나 미완료 보충은 여기 말고 아래 기록 목록에 바로 남아.</p>{extraSessionsToday.length?<div className="record-list full-record-list">{extraSessionsToday.map(s=><RecordRow key={s.at} item={s} onDelete={removeSession}/>)}</div>:<div className="catchup-empty"><Check size={17}/><span>오늘 추가로 기록한 공부가 아직 없어.</span></div>}<label className="daily-goal-note">메모<textarea value={goalNote} onChange={event=>setGoalNote(event.target.value)} placeholder="미흡한 부분, 보충학습, 내일로 넘길 내용 등을 적어줘."/></label><button className="export-button daily-goal-save" type="button" disabled={!goalNote.trim()} onClick={saveDailyGoalNote}>메모 저장</button>{savedMemos.length>0&&<div className="memo-list"><div className="eyebrow">저장한 메모</div>{savedMemos.map(memo=><div className="memo-item" key={memo.key}><div><small>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(new Date(memo.date+'T00:00:00'))}</small><p>{memo.text}</p></div><button className="delete-button" aria-label="메모 삭제" onClick={()=>deleteMemo(memo)}><X size={15}/></button></div>)}</div>}</section><div className="week-switch"><button className="icon-button" onClick={()=>setWeekShift(weekShift-1)}><ChevronLeft size={18}/></button><b>{new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[0])} – {new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[6])}</b><button className="icon-button" onClick={()=>setWeekShift(weekShift+1)}><ChevronRight size={18}/></button><button className="today-button" onClick={()=>setWeekShift(0)}>이번 주</button></div><div className="record-summary"><div><span>{weekShift===0?'이번 주':'선택한 주'} 순공부</span><b>{fmt(weekMinutes)}</b></div><div><span>기록 횟수</span><b>{weekSessions.length}회</b></div><div><span>{weekShift===0?'이번 주':'선택한 주'} 목표</span><b>{fmtHours(weekTargetHours)}시간</b></div></div><div className="panel logs-panel"><div className="panel-heading"><div><div className="eyebrow">{weekShift===0?'THIS WEEK':'SELECTED WEEK'}</div><h2>기록 목록</h2></div><span className="record-count">{weekSessions.length}개 기록</span></div>{weekSessions.length ? <div className="record-list full-record-list">{weekSessions.map(s=><RecordRow key={s.at} item={s} onDelete={removeSession}/>)}</div>:<div className="empty-state"><div className="empty-icon"><BookOpen size={20}/></div><b>아직 기록이 없어요</b><span>첫 공부 기록을 추가해 보세요.</span></div>}</div></>}
      {tab === '학습 통계 및 진도' && <><div className="page-title page-title-row"><div><div className="eyebrow">LECTURE TRACKER</div><h1>인강 진도</h1><p>기본이론 4개 과정만 한 달 일정에 넣었어. 강의 1개는 약 1시간으로 계산해.</p></div><div className="lecture-total"><b>{courseCompleted}<small> / {courseTotal}강</small></b><span>{courseTotal-courseCompleted}강 남음 · 약 {courseTotal-courseCompleted}시간</span></div></div><div className="course-subject-tabs"><span>기본이론 {data.courses.length}개</span><span>남은 수강 시간 약 {courseTotal-courseCompleted}시간</span></div>{subjects.filter(s=>data.courses.some(c=>c.subject===s)).map((subject,index)=>{const subjectCourses=data.courses.filter(c=>c.subject===subject);const subjectCompleted=subjectCourses.reduce((sum,c)=>sum+Number(c.completed),0);const subjectTotal=subjectCourses.reduce((sum,c)=>sum+Number(c.total),0);const subjectPct=subjectTotal?Math.round(subjectCompleted/subjectTotal*100):0;return <section className="panel course-group" key={subject}><div className="course-group-head"><span className={`subject-icon color-${subjects.indexOf(subject)}`}>{['영어','국어','행정법','행정학','한국사'].indexOf(subject)===0?'A':subject.slice(0,1)}</span><div className="course-group-summary"><div><b>{subject}</b><small>{subjectCompleted} / {subjectTotal}강 수강</small><div className="course-group-progress"><i style={{width:`${subjectPct}%`}}/></div></div><strong>{subjectPct}%</strong></div></div>{subjectCourses.map(course=>{const pct=Math.round(course.completed/course.total*100);return <div className="course-row" key={course.id}><div className="course-info"><div className="course-name"><b>{course.title}</b>{course.completed===course.total&&<span className="complete-tag">완강</span>}</div><div className="course-progress"><i style={{width:`${pct}%`}}/></div></div><div className="course-count"><b>{course.total}강</b><small>{course.completed}강 수강</small></div><div className="course-actions"><button className="lecture-complete" disabled={course.completed>=course.total} onClick={()=>completeLecture(course)}><Plus size={14}/> 1강 완료</button></div></div>})}</section>})}</>}
      {tab === '학습 통계 및 진도' && <><div className="page-title"><div className="eyebrow">YOUR PROGRESS</div><h1>학습 통계</h1><p>시간보다 중요한 건 꾸준히 쌓이는 실력이에요.</p></div><div className="week-switch"><button className="icon-button" onClick={()=>setWeekShift(weekShift-1)}><ChevronLeft size={18}/></button><b>{new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[0])} – {new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[6])}</b><button className="icon-button" onClick={()=>setWeekShift(weekShift+1)}><ChevronRight size={18}/></button><button className="today-button" onClick={()=>setWeekShift(0)}>이번 주</button></div><div className="analytics-top"><div className="panel analytic-total"><div className="eyebrow">{weekShift===0?'THIS WEEK':'SELECTED WEEK'} STUDY TIME</div><b>{fmt(weekMinutes)}</b><span>목표 {fmtHours(weekTargetHours)}시간 중 {Math.round((weekTargetMinutes ? weekMinutes/weekTargetMinutes*100 : 0))}% 달성</span><div className="progress"><i style={{width:`${Math.min((weekTargetMinutes ? weekMinutes/weekTargetMinutes*100 : 0),100)}%`}}/></div></div><div className="panel analytic-total soft"><div className="eyebrow">STUDY SESSIONS</div><b>{weekSessions.length}<small>회</small></b><span>{weekShift===0?'이번 주':'선택한 주'} 학습 기록 횟수</span><div className="spark-bars">{weekDates.map((d,i)=>{const m=weekSessions.filter(s=>s.date===dateKey(d)).reduce((a,s)=>a+Number(s.minutes),0);return <i key={i} style={{height:`${Math.max(m/540*100,6)}%`}} title={`${weekdays[i]} ${fmt(m)}`}/>})}</div></div></div><div className="panel analytics-panel"><div className="panel-heading"><div><div className="eyebrow">BY SUBJECT</div><h2>과목별 공부 시간</h2></div></div><div className="analytics-subjects">{subjects.map((s,i)=>{const mins=weekSessions.filter(x=>x.subject===s).reduce((a,x)=>a+Number(x.minutes),0);return <div className="analytics-subject" key={s}><div><span className={`subject-icon color-${i}`}>{['A','국','법','행','한'][i]}</span><b>{s}</b><strong>{fmt(mins)}</strong></div><div className="large-bar"><i style={{width:`${Math.min(weekMinutes?mins/weekMinutes*100:0,100)}%`}}/></div></div>})}</div></div></>}
      {tab === '설정' && <><div className="page-title"><div className="eyebrow">PREFERENCES</div><h1>설정</h1><p>나의 수험 계획과 데이터를 관리해.</p></div><section className="panel connection-panel"><div className="panel-heading"><div><div className="eyebrow">SUPABASE</div><h2>기기 간 기록 동기화</h2></div><span className={`connection-status ${syncStatus}`}>{syncStatus==='synced'?'연결됨':syncStatus==='syncing'?'동기화 중':syncStatus==='error'?'확인 필요':supabaseConfigured?'로그인 전':'설정 필요'}</span></div>{!supabaseConfigured?<div className="connection-copy"><p>Vercel 프로젝트 환경변수에 아래 두 항목을 추가하고 새 배포를 만들어줘.</p><code>VITE_SUPABASE_URL</code><code>VITE_SUPABASE_PUBLISHABLE_KEY</code><small>Supabase 프로젝트 URL과 Publishable key를 사용해. Secret 또는 service_role 키는 넣지 마.</small></div>:authUser&&authMode==='set-password'?<form className="connection-form" onSubmit={updatePassword}><p>새 비밀번호를 정해줘. 이메일 링크 인증이 완료된 계정에 적용돼.</p><label>새 비밀번호<input type="password" required minLength={8} autoComplete="new-password" value={authPassword} onChange={event=>setAuthPassword(event.target.value)}/></label><label>새 비밀번호 확인<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)}/></label><button className="primary-button" type="submit" disabled={authBusy}>{authBusy?'저장 중':'비밀번호 저장'}</button></form>:authUser?<div className="connection-account"><p><b>{authUser.email}</b> 계정으로 기록을 동기화하고 있어.</p><p>현재 상태: {syncStatus==='synced'?'모든 기록이 저장됐어.':syncStatus==='syncing'?'기록을 저장하는 중이야.':syncStatus==='error'?'동기화 오류가 있어. SQL 적용과 네트워크를 확인해줘.':'연결을 준비 중이야.'}</p><button className="export-button" onClick={signOut}><LogOut size={15}/> 로그아웃</button></div>:<div className="connection-form"><p>{authMode==='signup'?'이메일과 비밀번호로 계정을 만들자. 이메일 확인이 켜져 있으면 확인 메일 링크를 눌러야 가입이 완료돼.':authMode==='reset'?'가입한 이메일을 입력하면 비밀번호 재설정 링크를 보내줄게.':'가입한 이메일과 비밀번호를 입력해 로그인해.'}</p><form onSubmit={authMode==='signup'?signUpWithPassword:authMode==='reset'?sendPasswordReset:signInWithPassword}><label>이메일 주소<input type="email" required autoComplete="email" placeholder="name@example.com" value={authEmail} onChange={event=>setAuthEmail(event.target.value)}/></label>{authMode!=='reset'&&<label>비밀번호<input type="password" required minLength={authMode==='signup'?8:1} autoComplete={authMode==='signup'?'new-password':'current-password'} value={authPassword} onChange={event=>setAuthPassword(event.target.value)}/></label>}{authMode==='signup'&&<label>비밀번호 확인<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)}/></label>}<button className="primary-button" type="submit" disabled={authBusy}>{authBusy?'잠시만…':authMode==='signup'?'가입하기':authMode==='reset'?'재설정 메일 받기':'로그인'}</button></form><div className="auth-mode-links">{authMode==='login'?<><button type="button" onClick={()=>{setAuthMode('signup');setAuthMessage('');}}>새 계정 만들기</button><button type="button" onClick={()=>{setAuthMode('reset');setAuthMessage('');}}>비밀번호 잊어버렸어</button></>:<button type="button" onClick={()=>{setAuthMode('login');setAuthMessage('');}}>로그인으로 돌아가기</button>}</div></div>}{authMessage&&<p className="auth-message" role="status">{authMessage}</p>}</section><div className="panel settings-panel">{examList.map(exam=><div className="setting-row" key={exam.id}><div className="setting-icon"><Target size={18}/></div><div><b>{exam.name}</b><small>{exam.track?`${exam.track} · `:''}{examDateText(exam)}</small></div><span className="setting-value dday-value">{ddayLabel(exam.date)}</span><button className="export-button exam-edit" type="button" onClick={()=>openExamForm(exam)}>수정</button><button className="delete-button" type="button" aria-label="시험 삭제" onClick={()=>deleteExam(exam)}><X size={15}/></button></div>)}<div className="setting-row exam-add-row"><button className="export-button" type="button" onClick={()=>openExamForm(null)}><Plus size={15}/> 시험 추가</button></div><div className="setting-row"><div className="setting-icon"><Clock3 size={18}/></div><div><b>이번 주 공부 목표</b><small>기본이론 강의 배정 + 영단어 1시간씩</small></div><span className="setting-value">{fmtHours(weekTargetHours)}시간</span></div><div className="setting-row"><div className="setting-icon"><BriefcaseBusiness size={18}/></div><div><b>근무 일정</b><small>월–수 20:00–24:00 · 11/12·13 추가 근무 · 11/20 16:00–20:00</small></div><span className="setting-value">11월</span></div></div><div className="panel settings-panel"><div className="panel-heading"><div><div className="eyebrow">DATA</div><h2>내 기록</h2></div></div><p className="settings-copy">현재 기록은 이 브라우저에 자동 저장돼. 다른 기기에서도 쓰려면 Supabase 연결이 필요해.</p><button className="export-button" onClick={()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='합격기록장-백업.json';a.click();URL.revokeObjectURL(a.href);}}>기록 백업 다운로드 <ArrowRight size={15}/></button><label className="export-button import-button">백업에서 기록 불러오기<input type="file" accept="application/json,.json" hidden onChange={importBackup}/></label></div></>}
      </div><footer className="footer"><span>합격 기록장 <i>·</i> 하루씩 쌓는 나의 합격 기록</span><span>STAY STEADY, KEEP GOING.</span></footer></main>
      {mobileMenuOpen&&<div className="sidebar-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setMobileMenuOpen(false)}}/>}
      <nav className="mobile-nav">{menu.map(({label,icon:Icon})=><button className={tab===label?'selected':''} key={label} onClick={()=>setTab(label)}><Icon size={19}/><small>{label}</small></button>)}</nav>
      {(modal==='session'||modal==='trip') && <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)setModal('')}}><div className="modal"><div className="modal-head"><div><div className="eyebrow">{modal==='session'?'STUDY LOG':'WALKING ROUTE'}</div><h2>{modal==='session'?'공부 기록 추가':'이동 경로 추가'}</h2></div><button className="icon-button" onClick={()=>setModal('')}><X size={18}/></button></div>{modal==='session'?<form onSubmit={addSession}>{form.kind!=='인강 시청'&&<label>과목<select value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})}>{subjects.map(s=><option key={s}>{s}</option>)}</select></label>}<label>학습 종류<select value={form.kind} onChange={e=>setForm({...form,kind:e.target.value})}><option>복습·문제풀이</option><option>인강 시청</option><option>단어 암기</option><option>모의고사</option></select></label>{form.kind==='인강 시청'&&<><label>강의 과정<select value={formCourse?.id||''} onChange={e=>setForm({...form,courseId:e.target.value,lecture:''})}>{data.courses.map(c=><option value={c.id} key={c.id}>{c.subject} · {c.title.replace(/^\[\d+\]\s*/, '')}</option>)}</select></label><label>수료한 강의<select value={formLecture||''} onChange={e=>setForm({...form,lecture:e.target.value})}>{formLectureOptions.length?formLectureOptions.map(n=><option value={n} key={n}>{n}강</option>):<option value="">모두 수료했어요</option>}</select></label></>}<label>공부 시간<select value={form.minutes} onChange={e=>setForm({...form,minutes:e.target.value})}>{[25,30,45,60,90,120,150,180].map(n=><option value={n} key={n}>{n<60?`${n}분`:`${Math.floor(n/60)}시간${n%60?` ${n%60}분`:''}`}</option>)}</select></label><label>오늘 공부한 내용 <textarea placeholder="예: 행정법 기본강의 3강, 처분성 기출 10문제" value={form.memo} onChange={e=>setForm({...form,memo:e.target.value})}/></label><button className="primary-button submit-button" type="submit"><Check size={16}/> 기록 저장</button></form>:<form onSubmit={addTrip}><label>이동 경로<input required placeholder="예: 집 → 도서관" value={tripForm.route} onChange={e=>setTripForm({...tripForm,route:e.target.value})}/></label><label>소요 시간<select value={tripForm.minutes} onChange={e=>setTripForm({...tripForm,minutes:e.target.value})}>{[2,5,9,10,12,13,15,20,25,30,40,60].map(n=><option value={n} key={n}>{n}분</option>)}</select></label><label>메모<input value={tripForm.note} onChange={e=>setTripForm({...tripForm,note:e.target.value})}/></label><button className="primary-button submit-button" type="submit"><Check size={16}/> 이동 기록 저장</button></form>}</div></div>}{modal==='exam'&&<div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)setModal('')}}><div className="modal"><div className="modal-head"><div><div className="eyebrow">TARGET EXAM</div><h2>{examForm.id?'시험 수정':'시험 추가'}</h2></div><button className="icon-button" onClick={()=>setModal('')}><X size={18}/></button></div><form onSubmit={saveExam}><label>시험 이름<input required placeholder="예: 서울시 9급 공무원 시험" value={examForm.name} onChange={e=>setExamForm({...examForm,name:e.target.value})}/></label><label>직렬<input placeholder="예: 일반행정" value={examForm.track} onChange={e=>setExamForm({...examForm,track:e.target.value})}/></label><label>시험 날짜<input type="date" value={examForm.date} onChange={e=>setExamForm({...examForm,date:e.target.value})}/></label><p className="daily-goal-help">날짜를 정하지 않았다면 비워 두세요. 일정 미정으로 표시돼요.</p><button className="primary-button submit-button" type="submit"><Check size={16}/> 저장</button></form></div></div>}{toast&&<div className="toast"><Check size={15}/>{toast}</div>}
    </div>
}
function dayTarget(d, lecturePlan){const key=dateKey(d);if(noStudyDates.has(key))return 0;const planned=lecturePlan.find(day=>dateKey(day.date)===key);if(planned)return planned.goal+planned.wordMinutes/60;if(key>='2026-11-11'&&key<=lecturePlanEnd)return 1;return baseHours[(d.getDay()+6)%7]}
function topSubject(sessions){if(!sessions.length)return '—';return subjects.map(s=>[s,sessions.filter(x=>x.subject===s).reduce((a,x)=>a+Number(x.minutes),0)]).sort((a,b)=>b[1]-a[1])[0][0]}
function legacyTodaySchedule(d){const day=(d.getDay()+6)%7;const schedule=day>=3?[['기본이론 강의 · 복습','집중 학습 · 3시간','행정법','13:15–16:15','study']]:[['영어 단어 암기','매일 루틴 · 1시간','영어','09:15–10:15','study'],['기본이론 강의','집중 학습','국어 · 행정법 · 행정학','10:30–12:30','study']];return schedule.map(([title,sub,subject,time,type])=>({title,sub,subject,time,type})).concat(day<3?[{title:'편의점 근무',sub:'정기 근무',time:'20:00–24:00',type:'work'}]:[])}
function todaySchedule(d, lecturePlan){
  const key=dateKey(d), planned=lecturePlan.find(day=>dateKey(day.date)===key);
  if(noStudyDates.has(key))return [{title:'예비군',sub:'학습 배정 없음',time:'종일',type:'break'}];
  if(!planned)return legacyTodaySchedule(d);
  let cursor=key==='2026-11-20'?360:420;
  const schedule=[];
  const showTime=value=>`${String(Math.floor(value/60)%24).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
  const add=(title,sub,subject,duration,type='study')=>{schedule.push({title,sub,subject,time:`${showTime(cursor)}–${showTime(cursor+duration)}`,type,tag:title.startsWith('영단어')?'매일':''});cursor+=duration;};
  add('영단어 암기',`${key<'2026-11-11'?'교재 도착 전 · 기본 단어 복습':'교재 도착 후 · 신규 단어와 누적 복습'}${planned.wordRecoveryMinutes?` · 미완료 ${planned.wordRecoveryMinutes}분 보충`:''}`,'영어',planned.wordMinutes);
  if(planned.tasks.length)add('짧은 휴식','눈과 몸을 쉬어줘','',30,'break');
  let lectureHours=0,lunchAdded=false;
  planned.tasks.forEach(({course,count,lectureNumbers=[]})=>{
    let remaining=count,lectureIndex=0;
    while(remaining>0){
      const chunk=Math.min(2,remaining);
      const title=course.title.replace(/^\[\d+\]\s*/, '').replace(' 기본이론','');
      const chunkNumbers=lectureNumbers.slice(lectureIndex,lectureIndex+chunk);
       add(`${course.subject} 기본이론`,`${title} · ${chunkNumbers.length?`${chunkNumbers[0]}–${chunkNumbers[chunkNumbers.length-1]}강`:`${chunk}강`} 시청`,course.subject,chunk*60);
       lectureIndex+=chunk;
      lectureHours+=chunk;
      remaining-=chunk;
      if(lectureHours<planned.goal){
        if(!lunchAdded&&lectureHours>=Math.ceil(planned.goal/2)){add('점심 및 휴식','식사와 재충전','',60,'break');lunchAdded=true;}
        else add('휴식','다음 강의 전 잠깐 쉬어가기','',20,'break');
      }
    }
  });

  if(key==='2026-11-20')schedule.push({title:'추가 근무',sub:'편의점 근무',time:'16:00–20:00',type:'work'});
  if(key==='2026-11-12'||key==='2026-11-13')schedule.push({title:'추가 근무',sub:'편의점 근무',time:'20:00–24:00',type:'work'});
  else if([1,2,3].includes(d.getDay()))schedule.push({title:'편의점 근무',sub:'정기 근무',time:'20:00–24:00',type:'work'});
  return schedule.sort((a,b)=>a.time.localeCompare(b.time));
}
function RecordRow({item,onDelete}){return <div className="record-row"><div className={`record-subject ${subjects.indexOf(item.subject)>=0?`color-${subjects.indexOf(item.subject)}`:''}`}>{item.subject==='영어'?'A':item.subject.slice(0,1)}</div><div className="record-detail"><b>{item.subject} <span>· {item.kind}</span></b><small>{cleanMemo(item.memo)||'기록한 공부 시간'}</small></div><div className="record-time"><b>{fmt(Number(item.minutes))}</b><small>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(new Date(item.date+'T00:00:00'))}</small></div><button className="delete-button" aria-label="기록 삭제" onClick={()=>onDelete(item.at)}><X size={15}/></button></div>}
export default App;
