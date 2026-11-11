import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CalendarDays, ChartNoAxesColumn, Clock3, Coffee, Home, MapPin, Plus, Settings2, Sparkles, Target, Train, X, Check, ChevronLeft, ChevronRight, ArrowRight, BriefcaseBusiness, Cloud, CloudOff, LogOut } from 'lucide-react';
import { supabase, supabaseConfigured } from './lib/supabase.js';
import { addLocalIds, mergeStudyData, readRemoteData, writeRemoteData } from './lib/sync.js';

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

function allocateLectureDays(courses, remaining, dates) {
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
  const quotas = dates.map((_, dayIndex) => {
    if (fixed.has(dayIndex)) return fixed.get(dayIndex);
    const quota = base + (Math.floor((flexibleIndex + 1) * extra / Math.max(1, flexibleDays)) > Math.floor(flexibleIndex * extra / Math.max(1, flexibleDays)) ? 1 : 0);
    flexibleIndex++;
    return quota;
  });
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

  const todayCompletedByCourse = new Map(courses.map(course => [
    course.id,
    planSessions.filter(session => session.courseId === course.id && session.date === todayKeyValue).length,
  ]));
  const nextNumber = new Map(initialCourses.map(course => [course.id, Number(course.completed) + 1]));
  const numberedDays = baseDays.map(day => {
    const key = dateKey(day.date);
    const isPast = key < todayKeyValue;
    const isToday = key === todayKeyValue;
    const tasks = day.tasks.map(({ course, count }) => {
      const planned = nextNumber.get(course.id) || 1;
      let first = planned;
      if (isToday) {
        const startOfToday = Number(course.completed) - (todayCompletedByCourse.get(course.id) || 0) + 1;
        first = Math.max(planned, startOfToday);
      }
      const total = Number(course.total);
      let after = first + count;
      if (!isPast) after = Math.max(after, Number(course.completed) + 1);
      nextNumber.set(course.id, after);
      const lectureNumbers = Array.from({ length: count }, (_, index) => first + index).filter(n => n <= total);
      return { course, count: lectureNumbers.length, lectureNumbers };
    }).filter(task => task.count > 0);
    return { ...day, goal: tasks.reduce((sum, task) => sum + task.count, 0), tasks };
  });

  const historical = numberedDays.filter(day => dateKey(day.date) < todayKeyValue);
  const missedWordMinutes = historical.reduce((sum, day) => {
    const key = dateKey(day.date);
    const wordMinutes = sessions.filter(session => session.date === key && session.kind === '단어 암기')
      .reduce((total, session) => total + Number(session.minutes), 0);
    return sum + Math.max(0, 60 - wordMinutes);
  }, 0);
  const recoveredWordMinutes = sessions
    .filter(session => session.kind === '단어 암기' && String(session.memo || '').startsWith('[catchup:words|'))
    .reduce((sum, session) => sum + Number(session.minutes), 0);
  const carryWordMinutes = Math.max(0, missedWordMinutes - recoveredWordMinutes);
  const remainingDays = numberedDays.filter(day => dateKey(day.date) >= todayKeyValue).length;
  const dailyWordRecovery = remainingDays ? Math.floor(carryWordMinutes / remainingDays) : 0;
  let extraWordMinutes = remainingDays ? carryWordMinutes % remainingDays : 0;

  return numberedDays.map(day => {
    const key = dateKey(day.date);
    const actualByCourse = courses.map(course =>
      planSessions.filter(session => session.courseId === course.id && session.date === key).length
    );
    const missedTasks = key < todayKeyValue
      ? day.tasks.map(({ course, count }) => ({
          course,
          count: Math.max(0, count - actualByCourse[courses.findIndex(item => item.id === course.id)]),
        })).filter(task => task.count)
      : [];
    const actualMinutes = sessions.filter(session => session.date === key)
      .reduce((sum, session) => sum + Number(session.minutes), 0);
    const vocabularyMinutes = sessions.filter(session => session.date === key && session.kind === '단어 암기')
      .reduce((sum, session) => sum + Number(session.minutes), 0);
    const isFutureOrToday = key >= todayKeyValue;
    const wordRecoveryMinutes = isFutureOrToday
      ? dailyWordRecovery + (extraWordMinutes-- > 0 ? 1 : 0)
      : 0;
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
function buildStudyBacklog(lecturePlan, sessions) {
  const completed = new Map();
  sessions.forEach(session => {
    const match = String(session.memo || '').match(/^\[catchup:([^\]]+)\]/);
    if (match) completed.set(match[1], session);
  });
  const pending = [];
  const done = [];
  lecturePlan.filter(day => dateKey(day.date) < todayKey()).forEach(day => {
    const dueDate = dateKey(day.date);
    day.missedTasks.forEach(({ course, count }) => {
      for (let index = 1; index <= count; index++) {
        const id = `lecture|${dueDate}|${course.id}|${index}`;
        const item = { id, type: 'lecture', date: day.date, course, subject: course.subject, title: course.title.replace(/^\[\d+\]\s*/, ''), minutes: 60 };
        const completion = completed.get(id);
        (completion ? done : pending).push(completion ? { ...item, completedDate: completion.date } : item);
      }
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
    const initial = addLocalIds(load());
    try { localStorage.setItem('pass-note', JSON.stringify(initial)); } catch { /* Keep the in-memory copy when storage is unavailable. */ }
    return initial;
  });
  const [tab, setTab] = useState('홈');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [modal, setModal] = useState('');
  const [weekShift, setWeekShift] = useState(0);
  const [form, setForm] = useState({ subject: '영어', kind: '복습·문제풀이', minutes: 60, memo: '' });
  const [goalInput, setGoalInput] = useState('');
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
  const save = (next, removedSessionIds = []) => {
    const normalized = addLocalIds(next);
    setData(normalized);
    try { localStorage.setItem('pass-note', JSON.stringify(normalized)); } catch { /* Keep the in-memory copy when storage is unavailable. */ }
    if (supabase && authUser && syncReady) {
      setSyncStatus('syncing');
      writeRemoteData(supabase, authUser.id, normalized, removedSessionIds)
        .then(() => setSyncStatus('synced'))
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
        const merged = mergeStudyData(remote, local);
        localStorage.setItem('pass-note', JSON.stringify(merged));
        setData(merged);
        await writeRemoteData(supabase, authUser.id, merged);
        if (active) { setSyncReady(true); setSyncStatus('synced'); setAuthMessage('이 기기의 기록을 계정과 동기화했어.'); }
      } catch (error) {
        if (active) { setSyncReady(false); setSyncStatus('error'); setAuthMessage(`연결에 실패했어: ${error.message} · Supabase SQL 적용 여부를 확인해줘.`); }
      }
    })();
    return () => { active = false; };
  }, [authUser?.id]);

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
  const sessionsToday = data.sessions.filter((s) => s.date === todayKey());
  const todayGoals = data.dailyGoals?.[todayKey()] || { tasks: [], note: '' };
  useEffect(() => { setGoalNote(todayGoals.note || ''); }, [data.dailyGoals]);
  const todayMinutes = sessionsToday.reduce((a, s) => a + Number(s.minutes), 0);
  const courseCompleted = data.courses.reduce((sum,c)=>sum+Number(c.completed),0);
  const courseTotal = data.courses.reduce((sum,c)=>sum+Number(c.total),0);
  const lecturePlan = useMemo(() => buildLecturePlan(data.courses, data.sessions), [data.courses, data.sessions]);
  const studyBacklog = useMemo(() => buildStudyBacklog(lecturePlan, data.sessions), [lecturePlan, data.sessions]);
  const todayPlan = lecturePlan.find(day => dateKey(day.date) === todayKey());
  const futureLectureDays = lecturePlan.filter(day => dateKey(day.date) >= todayKey()).length;
  const todayActualLectures = sessionsToday.filter(session => session.courseId && session.kind === '인강 시청').length;
  const todayActualWords = sessionsToday.filter(session => session.kind === '단어 암기').reduce((sum, session) => sum + Number(session.minutes), 0);
  const todayUnfinishedLectures = todayPlan ? Math.max(0, todayPlan.goal - todayActualLectures) : 0;
  const todayUnfinishedMinutes = todayPlan ? todayUnfinishedLectures * 60 + Math.max(0, todayPlan.wordMinutes - todayActualWords) : 0;
  const todayActualLecturesByCourse = Object.fromEntries(data.courses.map(course => [course.id, sessionsToday.filter(session => session.courseId === course.id && session.kind === '인강 시청').length]));
  const todayGoalLectureTasks = (todayPlan?.tasks || []).flatMap(({ course, count, lectureNumbers = [] }) => Array.from({ length: count }, (_, index) => ({ course, lectureNumber: lectureNumbers[index] || Number(course.completed) - todayActualLecturesByCourse[course.id] + index + 1, key: `lecture:${course.id}:${lectureNumbers[index] || index + 1}` })));
  const todayGoalCompleted = todayGoalLectureTasks.reduce((sum, task) => sum + (task.lectureNumber <= Number(task.course.completed) ? 1 : 0), 0) + (todayGoals.tasks || []).filter(task => task.done).length;
  const todayGoalTotal = todayGoalLectureTasks.length + (todayGoals.tasks || []).length;
  const weekStart = useMemo(() => { const d = studyDate(weekShift * 7); d.setDate(d.getDate() - (d.getDay() + 6) % 7); d.setHours(0, 0, 0, 0); return d; }, [weekShift]);
  const weekDates = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; });
  const weekSessions = data.sessions.filter((s) => s.date >= dateKey(weekDates[0]) && s.date <= dateKey(weekDates[6]));
  const weekMinutes = weekSessions.reduce((a, s) => a + Number(s.minutes), 0);
  const weekTargetHours = weekDates.reduce((sum, d) => sum + dayTarget(d, lecturePlan), 0);
  const weekTargetMinutes = weekTargetHours * 60;
  const addSession = (e) => { e.preventDefault(); save({ ...data, sessions: [{ ...form, minutes: Number(form.minutes), date: todayKey(), at: new Date().toISOString() }, ...data.sessions] }); setModal(''); setToast('공부 기록을 저장했어요'); setTimeout(() => setToast(''), 2400); };
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
  const saveDailyGoalNote = () => {
    const dailyGoals = {
      ...(data.dailyGoals || {}),
      [todayKey()]: { ...todayGoals, note: goalNote },
    };
    save({ ...data, dailyGoals });
    setToast('오늘의 메모를 저장했어');
    setTimeout(() => setToast(''), 2200);
  };
  const completeLecture = (course) => { if (course.completed >= course.total) return; const nextCourse = { ...course, completed: course.completed + 1 }; const now = new Date().toISOString(); const pendingCatchup = studyBacklog.pending.find(item => item.type === 'lecture' && item.course.id === course.id); const marker = pendingCatchup ? `[catchup:${pendingCatchup.id}] ` : ''; const session = { subject: course.subject, kind: '인강 시청', courseId: course.id, minutes: 60, memo: `${marker}${course.title} · ${nextCourse.completed}강 수강 완료`, date: todayKey(), at: now }; save({ ...data, courses: data.courses.map(c => c.id === course.id ? nextCourse : c), sessions: [session, ...data.sessions] }); setToast(pendingCatchup ? `${course.title} 미완료 강의 1강도 함께 정리했어` : `${course.title} ${nextCourse.completed}강 완료 · 1시간 기록`); setTimeout(() => setToast(''), 2600); };
  const recordCatchup = (item) => {
    const at = new Date().toISOString();
    const marker = `[catchup:${item.id}]`;
    if (item.type === 'lecture') {
      const course = data.courses.find(entry => entry.id === item.course.id);
      if (!course) return;
      if (course.completed >= course.total) {
        const existing = data.sessions.find(session => session.courseId === course.id && session.kind === '인강 시청' && session.date >= dateKey(item.date));
        const sessions = existing
          ? data.sessions.map(session => session.at === existing.at ? { ...session, memo: `${marker} ${session.memo || item.title}` } : session)
          : [{ subject: course.subject, kind: '보충 완료', courseId: course.id, minutes: 0, memo: `${marker} ${item.title} 이전 완료분 확인`, date: todayKey(), at } , ...data.sessions];
        save({ ...data, sessions });
        setToast(`${item.title} 완료 기록을 연결했어`);
        setTimeout(() => setToast(''), 2600);
        return;
      }
      const nextCourse = { ...course, completed: course.completed + 1 };
      const session = { subject: course.subject, kind: '인강 시청', courseId: course.id, minutes: 60, memo: `${marker} ${item.title} · ${new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(item.date)} 미완료분 보충`, date: todayKey(), at };
      save({ ...data, courses: data.courses.map(entry => entry.id === course.id ? nextCourse : entry), sessions: [session, ...data.sessions] });
      setToast(`${item.title} 보충 완료로 기록했어`);
    } else {
      const session = { subject: '영어', kind: '단어 암기', minutes: item.minutes, memo: `${marker} ${new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(item.date)} 미완료분 보충`, date: todayKey(), at };
      save({ ...data, sessions: [session, ...data.sessions] });
      setToast(`영단어 ${fmtMinutes(item.minutes)} 보충 완료로 기록했어`);
    }
    setTimeout(() => setToast(''), 2600);
  };
  const removeSession = (at) => { const removed = data.sessions.find((s) => s.at === at); const courses = removed?.courseId ? data.courses.map(c => c.id === removed.courseId ? { ...c, completed: Math.max(0, c.completed - 1) } : c) : data.courses; save({ ...data, courses, sessions: data.sessions.filter((s) => s.at !== at) }, removed ? [removed.localId || removed.at] : []); };
  const menu = [{ label: '홈', icon: Home }, { label: '오늘의 시간표', icon: CalendarDays }, { label: '일정', icon: CalendarDays }, { label: '공부 기록', icon: Clock3 }, { label: '학습 통계 및 진도', icon: ChartNoAxesColumn }, { label: '설정', icon: Settings2 }];
  return <div className="app-shell">
    <aside className={mobileMenuOpen?"sidebar is-open":"sidebar"}><div className="brand"><button className="brand-home" onClick={()=>{setTab('홈');setMobileMenuOpen(false)}} aria-label="합격 기록장 홈으로"><div className="brand-mark"><Sparkles size={18}/></div><div><strong>합격 기록장</strong><span>MY STUDY JOURNAL</span></div></button><button className="sidebar-close icon-button" onClick={()=>setMobileMenuOpen(false)} aria-label="사이드 메뉴 닫기"><X size={17}/></button></div><div className="profile-card"><div className="avatar">수</div><div><b>나의 수험 기록</b><small>2027 제주 지방직 9급</small></div><ChevronRight size={16} className="muted"/></div><div className="side-label">MENU</div><nav>{menu.map(({label, icon: Icon}) => <button key={label} className={`nav-item ${tab === label ? 'active' : ''}`} onClick={() => {setTab(label);setMobileMenuOpen(false)}}><Icon size={18}/>{label}{label === '홈' && <span className="nav-dot"/>}</button>)}</nav><div className="side-label plan-label">MY GOAL</div><div className="goal-mini"><div className="goal-line"><Target size={17}/><b>주간 목표</b></div><strong>{fmtHours(weekTargetHours)}<span>시간</span></strong><div className="mini-track"><i style={{width:`${Math.min(weekTargetMinutes ? weekMinutes / weekTargetMinutes * 100 : 0,100)}%`}}/></div><small>{fmt(weekMinutes)} 달성</small></div><div className="sidebar-bottom"><div className="sync-state"><i/> {syncStatus==='synced'?'Supabase 동기화됨':syncStatus==='syncing'?'동기화 중':syncStatus==='error'?'동기화 확인 필요':supabaseConfigured?'로그인 후 동기화':'이 기기에 자동 저장'}</div></div></aside>
    <main className="main"><header className="topbar"><div className="header-brand-group"><button className="header-brand" onClick={()=>setMobileMenuOpen(!mobileMenuOpen)} aria-label={mobileMenuOpen?"메뉴 닫기":"메뉴 열기"} aria-expanded={mobileMenuOpen}><Sparkles size={17}/> 합격 기록장</button></div><div className="crumb">나의 학습 <span>/</span> <b>{tab}</b></div><div className="top-right"><button className={`sync-pill ${syncStatus}`} onClick={()=>setTab('설정')}><span className="sync-pill-icon">{syncStatus==='synced'?<Cloud size={15}/>:<CloudOff size={15}/>}</span>{syncStatus==='synced'?'동기화됨':syncStatus==='syncing'?'연결 중':syncStatus==='error'?'연결 확인':supabaseConfigured?'로그인 필요':'기기 저장'}</button><span className="date-pill"><CalendarDays size={15}/>{new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric',weekday:'short'}).format(new Date())}</span><div className="avatar small-avatar">수</div></div></header>
      <div className="content">{tab === '홈' && <>
<section className="welcome"><div><div className="eyebrow">{new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric'}).format(new Date()).toUpperCase()} · MY STUDY PLAN</div><h1>오늘도 한 걸음,<br/><em>합격에 가까워지고 있어요.</em></h1><p>꾸준히 쌓는 오늘의 공부가 내일의 실력이 됩니다.</p></div><div className="welcome-stamp"><span>2027</span><b>합격을 향해</b><small>ONE DAY AT A TIME</small></div></section>
<section className="stat-grid"><div className="stat-card primary-stat"><div className="stat-head"><span>오늘 순공부</span><Clock3 size={17}/></div><div className="stat-value">{(todayMinutes/60).toFixed(todayMinutes%60?1:0)}<small>시간</small></div><div className="stat-foot"><span className="green-chip">목표 {fmtHours(dayTarget(new Date(),lecturePlan))}시간</span><span>{Math.min(Math.round(todayMinutes/Math.max(dayTarget(new Date(),lecturePlan)*60,1)*100),100)}% 달성</span></div><div className="progress"><i style={{width:`${Math.min(todayMinutes/Math.max(dayTarget(new Date(),lecturePlan)*60,1)*100,100)}%`}}/></div></div><div className="stat-card"><div className="stat-head"><span>이번 주 순공부</span><Target size={17}/></div><div className="stat-value">{(weekMinutes/60).toFixed(weekMinutes%60?1:0)}<small>시간</small><b className="of-total">/ {fmtHours(weekTargetHours)}시간</b></div><div className="stat-foot"><span>목표까지</span><b>{fmt(Math.max(weekTargetMinutes-weekMinutes,0))}</b></div><div className="progress"><i className="blue-fill" style={{width:`${Math.min(weekTargetMinutes?weekMinutes/weekTargetMinutes*100:0,100)}%`}}/></div></div><div className="stat-card"><div className="stat-head"><span>이번 주 기록</span><BookOpen size={17}/></div><div className="stat-value">{weekSessions.length}<small>회</small></div><div className="stat-foot"><span>가장 많이 공부한 과목</span><b>{topSubject(weekSessions)}</b></div></div></section>
<div className="shift-notice"><BriefcaseBusiness size={16}/><span><b>11월 근무 일정</b> · 12일·13일 20:00–24:00 추가 근무 · 20일 16:00–20:00</span></div>
<details className="panel home-progress-panel" open><summary className="panel-heading"><div><div className="eyebrow">SUBJECT BALANCE</div><h2>과목별 학습 현황</h2></div></summary><div className="subject-list">{data.courses.map((course,i)=>{const pct=Math.round(course.completed/course.total*100);return <div className="subject-row" key={course.id}><span className={`subject-icon color-${i}`}>{course.subject==='영어'?'A':course.subject.slice(0,1)}</span><b>{course.subject}</b><div className="subject-bar"><i style={{width:`${pct}%`}}/></div><small>{course.completed}/{course.total}강</small></div>})}</div></details>
<section className="home-shortcuts"><button className="panel" onClick={()=>setTab('오늘의 시간표')}><CalendarDays size={20}/><b>오늘의 시간표</b><small>{todayPlan?.goal||0}강 배정 · 강의별 번호와 완료 체크</small></button><button className="panel" onClick={()=>setTab('일정')}><CalendarDays size={20}/><b>일정</b><small>주간 일정과 기본이론 완강 일정</small></button><button className="panel" onClick={()=>setTab('공부 기록')}><Clock3 size={20}/><b>공부 기록</b><small>공부 시간, 미완료·추가 공부 기록</small></button><button className="panel" onClick={()=>setTab('학습 통계 및 진도')}><ChartNoAxesColumn size={20}/><b>학습 통계 및 진도</b><small>{courseCompleted}/{courseTotal}강 완료</small></button></section>
</>}
{tab === '오늘의 시간표' && <>
<div className="page-title"><div className="eyebrow">TODAY'S TIMETABLE</div><h1>오늘의 시간표</h1><p>실제 수강할 과목과 강의 번호를 확인하고, 완료하면 바로 체크해줘.</p></div>
<section className="panel today-timetable-panel"><div className="panel-heading"><div><div className="eyebrow">TODAY'S PLAN</div><h2>시간대별 일정</h2></div><span className="record-count">{todayPlan?.goal||0}강 계획</span></div><div className="schedule-list">{todaySchedule(new Date(),lecturePlan).map((item,i)=><div className={`schedule-row ${item.type}`} key={i}><div className="time-col">{item.time}</div><div className="timeline"><i/></div><div className="schedule-info"><div className="schedule-title">{item.title}</div><small>{item.sub}</small></div>{item.type==='work'?<BriefcaseBusiness size={16}/>:item.type==='study'?<span className="subject-pill">{item.subject}</span>:<Coffee size={16}/>}</div>)}</div></section>
<section className="panel today-lecture-check-panel"><div className="panel-heading"><div><div className="eyebrow">LECTURE CHECK</div><h2>오늘 수강할 강의</h2></div><span className="record-count">{todayGoalCompleted}/{todayGoalTotal} 완료</span></div><div className="daily-goal-progress"><i style={{width:`${todayGoalTotal?todayGoalCompleted/todayGoalTotal*100:0}%`}}/></div><p className="daily-goal-help">강의 완료를 누르면 실제 진도와 공부 기록, 목표 체크에 한 번에 반영돼.</p><div className="daily-goal-list">{todayGoalLectureTasks.map(task=>{const checked=task.lectureNumber<=Number(data.courses.find(c=>c.id===task.course.id)?.completed||0);return <button type="button" className={`daily-goal-item ${checked?'done':''}`} key={task.key} disabled={checked} onClick={()=>completeLecture(data.courses.find(c=>c.id===task.course.id))}><span className="daily-goal-check">{checked&&<Check size={15}/>}</span><span><b>{task.course.subject} · {task.lectureNumber}강</b><small>{task.course.title.replace(/^\[\d+\]\s*/, '')}</small></span></button>})}</div></section>
</>}
{tab === '일정' && <>
<div className="page-title"><div className="eyebrow">SCHEDULE</div><h1>일정</h1><p>이번 주 일정과 강의 번호, 기본이론 완강 일정을 한눈에 확인해.</p></div>

<div className="week-switch"><button className="icon-button" onClick={()=>setWeekShift(weekShift-1)}><ChevronLeft size={18}/></button><b>{new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[0])} – {new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[6])}</b><button className="icon-button" onClick={()=>setWeekShift(weekShift+1)}><ChevronRight size={18}/></button><button className="today-button" onClick={()=>setWeekShift(0)}>이번 주</button></div><section className="weekly-agenda-grid">{weekDates.map((d,i)=>{const date=dateKey(d);const goal=dayTarget(d,lecturePlan);const mins=weekSessions.filter(item=>item.date===date).reduce((sum,item)=>sum+Number(item.minutes),0);const items=todaySchedule(d,lecturePlan);return <article className="panel weekly-day-card" key={date}><div className="weekly-day-header"><div><div className="weekly-day-title"><b>{weekdays[i]} {d.getDate()}일</b>{date===todayKey()&&<i>오늘</i>}</div><small>{items.filter(item=>item.type==='study').length}개 학습 블록 · 강의 번호 포함</small></div><strong>{fmtHours(goal)}<small>시간</small></strong></div><div className="weekly-day-progress"><i style={{width:`${Math.min(goal?mins/(goal*60)*100:0,100)}%`}}/></div><div className="weekly-agenda-list">{items.map((item,index)=><div className={`weekly-agenda-row ${item.type}`} key={`${item.time}-${index}`}><time>{item.time}</time><div><b>{item.title}</b><small>{item.sub}</small></div></div>)}</div></article>})}</section>
<details className="panel lecture-plan-panel compact-lecture-plan"><summary className="lecture-plan-summary"><div className="lecture-plan-head"><div><div className="eyebrow">NOV 11 – DEC 8</div><h2>기본이론 완강 일정</h2><p>남은 {courseTotal-courseCompleted}강 · 종료일은 12월 8일로 유지하고, 계획은 날짜대로 진행되고, 못 들은 강의는 미완료 목록에 남아.</p></div><span className="lecture-plan-total">11/12·13 근무 · 11/20 6강</span></div></summary><div className="lecture-plan-list">{lecturePlan.map(day=>{const key=dateKey(day.date);return <article className="lecture-plan-day" key={key}><div className="lecture-plan-date"><b>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',weekday:'short'}).format(day.date)}</b><span>{day.goal}강 <i>· 단어 {fmtMinutes(day.wordMinutes)}</i></span></div><div className="lecture-plan-tasks">{day.tasks.map(({course,count})=><span key={course.id}><b>{course.subject}</b>{course.title.replace(/^\[\d+\]\s*/, '')} · {count}강</span>)}</div>{key<todayKey()&&<div className="lecture-plan-status missed"><b>실제 {day.actualLectures}강 완료</b><span>미완료 {day.missedLectures}강 · 단어 {fmtMinutes(day.missedWordMinutes)}</span></div>}{key===todayKey()&&<div className="lecture-plan-status"><b>실제 {day.actualLectures}/{day.goal}강 · {fmt(day.actualMinutes)}</b><span>오늘 남은 강의 {todayUnfinishedLectures}강</span></div>}{key>todayKey()&&day.recoveryLectures>0&&<div className="lecture-plan-status recovery">미완료 강의 보충 +{day.recoveryLectures}강</div>}{key>todayKey()&&day.wordRecoveryMinutes>0&&<div className="lecture-plan-status recovery">단어 미완료 {day.wordRecoveryMinutes}분 보충</div>}{(key==='2026-11-20'||key==='2026-11-12'||key==='2026-11-13'||(day.date.getDay()>=1&&day.date.getDay()<=3))&&<div className="lecture-plan-work"><BriefcaseBusiness size={14}/>{key==='2026-11-20'?'추가 근무 16:00–20:00':'편의점 근무 20:00–24:00'}</div>}</article>})}</div><p className="lecture-plan-note">11월 11일 목표는 영어 2강·행정학 1강이야. 11월 12일부터 날짜별 배정량대로 진행하고(미완료분은 다음 날로 밀지 않아), 매일 단어 1시간을 포함해. 11월 12·13일은 20:00–24:00 근무를 반영했어. 12월 9–10일 예비군은 완강 일정 종료 이후라 배정하지 않아.</p></details>
</>}
{tab === '공부 기록' && <><div className="page-title page-title-row"><div><div className="eyebrow">STUDY LOG</div><h1>공부 기록</h1><p>강의 시청과 복습·문제풀이 시간을 구분해 기록해요.</p></div><button className="primary-button" onClick={()=>setModal('session')}><Plus size={17}/> 기록 추가</button></div><section className="panel study-plan-status"><div><span>오늘 계획</span><b>{todayPlan?.goal ?? 0}강 · 단어 {fmtMinutes(todayPlan?.wordMinutes ?? 0)}</b></div><div><span>실제 완료</span><b>{todayActualLectures}강 · {fmt(todayMinutes)}</b></div><p>미완료 {todayUnfinishedLectures}강 · {fmt(todayUnfinishedMinutes)} 은 내일로 밀리지 않고, 아래 미완료 공부 목록에 쌓여.</p></section><section className="panel catchup-panel"><div className="panel-heading"><div><div className="eyebrow">CATCH-UP LIST</div><h2>미완료 공부</h2></div><span className="record-count">{studyBacklog.pending.length}개 남음</span></div><p className="catchup-intro">하루가 지나면 못한 강의와 영단어가 여기에 쌓여. 실제로 보충한 뒤 완료 기록을 눌러 체크해줘.</p>{studyBacklog.pending.length?<div className="catchup-list">{studyBacklog.pending.map(item=><article className="catchup-item" key={item.id}><div className={`catchup-icon ${item.type}`}>{item.type==='lecture'?<BookOpen size={17}/>:<Clock3 size={17}/>}</div><div className="catchup-copy"><b>{item.title}</b><span>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',weekday:'short'}).format(item.date)} · {item.type==='lecture'?'1강 · 약 1시간':`단어 ${fmtMinutes(item.minutes)}`}</span></div><button className="catchup-complete" onClick={()=>recordCatchup(item)}>보충 완료</button></article>)}</div>:<div className="catchup-empty"><Check size={17}/><span>밀린 공부가 없어. 오늘 계획을 이어가자!</span></div>}{studyBacklog.done.length>0&&<details className="catchup-history"><summary>완료한 보충 {studyBacklog.done.length}건 보기</summary><div className="catchup-list">{studyBacklog.done.slice().reverse().map(item=><article className="catchup-item done" key={item.id}><div className="catchup-icon"><Check size={16}/></div><div className="catchup-copy"><b>{item.title}</b><span>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(item.date)} 미완료 · {new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(new Date(item.completedDate+'T00:00:00'))} 보충 완료</span></div><Check size={17}/></article>)}</div></details>}</section><section className="panel daily-goals-panel"><div className="panel-heading"><div><div className="eyebrow">EXTRA STUDY</div><h2>추가 공부 기록</h2></div><span className="record-count">{(todayGoals.tasks||[]).filter(task=>task.done).length}/{(todayGoals.tasks||[]).length} 완료</span></div><div className="daily-goal-progress"><i style={{width:`${(todayGoals.tasks||[]).length?(todayGoals.tasks||[]).filter(task=>task.done).length/(todayGoals.tasks||[]).length*100:0}%`}}/></div><p className="daily-goal-help">계획 강의 외에 추가로 공부한 내용이나 보충할 내용을 적고, 끝낸 건 눌러서 체크해.</p><div className="daily-goal-list">{(todayGoals.tasks||[]).map(task=><button type="button" className={`daily-goal-item ${task.done?'done':''}`} key={task.id} onClick={()=>toggleDailyGoal(task.id)}><span className="daily-goal-check">{task.done&&<Check size={15}/>}</span><span><b>{task.title}</b><small>추가 공부 · 눌러서 완료 상태 변경</small></span></button>)}</div><form className="daily-goal-add" onSubmit={addDailyGoal}><input value={goalInput} onChange={event=>setGoalInput(event.target.value)} placeholder="추가 공부 예: 행정법 복습 30분" aria-label="추가 공부"/><button className="export-button" type="submit" disabled={!goalInput.trim()}><Plus size={15}/> 추가</button></form><label className="daily-goal-note">오늘의 메모<textarea value={goalNote} onChange={event=>setGoalNote(event.target.value)} placeholder="미흡한 부분, 추가 공부, 보충학습, 내일로 넘길 내용 등을 적어줘."/></label><button className="export-button daily-goal-save" type="button" onClick={saveDailyGoalNote}>메모 저장</button></section><div className="record-summary"><div><span>이번 주 순공부</span><b>{fmt(weekMinutes)}</b></div><div><span>기록 횟수</span><b>{weekSessions.length}회</b></div><div><span>이번 주 목표</span><b>{fmtHours(weekTargetHours)}시간</b></div></div><div className="panel logs-panel"><div className="panel-heading"><div><div className="eyebrow">THIS WEEK</div><h2>기록 목록</h2></div><span className="record-count">{weekSessions.length}개 기록</span></div>{weekSessions.length ? <div className="record-list full-record-list">{weekSessions.map(s=><RecordRow key={s.at} item={s} onDelete={removeSession}/>)}</div>:<div className="empty-state"><div className="empty-icon"><BookOpen size={20}/></div><b>아직 기록이 없어요</b><span>첫 공부 기록을 추가해 보세요.</span></div>}</div></>}
      {tab === '학습 통계 및 진도' && <><div className="page-title page-title-row"><div><div className="eyebrow">LECTURE TRACKER</div><h1>인강 진도</h1><p>기본이론 4개 과정만 한 달 일정에 넣었어. 강의 1개는 약 1시간으로 계산해.</p></div><div className="lecture-total"><b>{courseCompleted}<small> / {courseTotal}강</small></b><span>{courseTotal-courseCompleted}강 남음 · 약 {courseTotal-courseCompleted}시간</span></div></div><div className="course-subject-tabs"><span>기본이론 {data.courses.length}개</span><span>남은 수강 시간 약 {courseTotal-courseCompleted}시간</span></div>{subjects.filter(s=>data.courses.some(c=>c.subject===s)).map((subject,index)=>{const subjectCourses=data.courses.filter(c=>c.subject===subject);const subjectCompleted=subjectCourses.reduce((sum,c)=>sum+Number(c.completed),0);const subjectTotal=subjectCourses.reduce((sum,c)=>sum+Number(c.total),0);const subjectPct=subjectTotal?Math.round(subjectCompleted/subjectTotal*100):0;return <section className="panel course-group" key={subject}><div className="course-group-head"><span className={`subject-icon color-${subjects.indexOf(subject)}`}>{['영어','국어','행정법','행정학','한국사'].indexOf(subject)===0?'A':subject.slice(0,1)}</span><div className="course-group-summary"><div><b>{subject}</b><small>{subjectCompleted} / {subjectTotal}강 수강</small><div className="course-group-progress"><i style={{width:`${subjectPct}%`}}/></div></div><strong>{subjectPct}%</strong></div></div>{subjectCourses.map(course=>{const pct=Math.round(course.completed/course.total*100);return <div className="course-row" key={course.id}><div className="course-info"><div className="course-name"><b>{course.title}</b>{course.completed===course.total&&<span className="complete-tag">완강</span>}</div><div className="course-progress"><i style={{width:`${pct}%`}}/></div></div><div className="course-count"><b>{course.total}강</b><small>{course.completed}강 수강</small></div><div className="course-actions"><button className="lecture-complete" disabled={course.completed>=course.total} onClick={()=>completeLecture(course)}><Plus size={14}/> 1강 완료</button></div></div>})}</section>})}</>}
      {tab === '학습 통계 및 진도' && <><div className="page-title"><div className="eyebrow">YOUR PROGRESS</div><h1>학습 통계</h1><p>시간보다 중요한 건 꾸준히 쌓이는 실력이에요.</p></div><div className="analytics-top"><div className="panel analytic-total"><div className="eyebrow">THIS WEEK STUDY TIME</div><b>{fmt(weekMinutes)}</b><span>목표 {fmtHours(weekTargetHours)}시간 중 {Math.round((weekTargetMinutes ? weekMinutes/weekTargetMinutes*100 : 0))}% 달성</span><div className="progress"><i style={{width:`${Math.min((weekTargetMinutes ? weekMinutes/weekTargetMinutes*100 : 0),100)}%`}}/></div></div><div className="panel analytic-total soft"><div className="eyebrow">STUDY SESSIONS</div><b>{weekSessions.length}<small>회</small></b><span>이번 주 학습 기록 횟수</span><div className="spark-bars">{weekDates.map((d,i)=>{const m=weekSessions.filter(s=>s.date===dateKey(d)).reduce((a,s)=>a+Number(s.minutes),0);return <i key={i} style={{height:`${Math.max(m/540*100,6)}%`}} title={`${weekdays[i]} ${fmt(m)}`}/>})}</div></div></div><div className="panel analytics-panel"><div className="panel-heading"><div><div className="eyebrow">BY SUBJECT</div><h2>과목별 공부 시간</h2></div></div><div className="analytics-subjects">{subjects.map((s,i)=>{const mins=weekSessions.filter(x=>x.subject===s).reduce((a,x)=>a+Number(x.minutes),0);return <div className="analytics-subject" key={s}><div><span className={`subject-icon color-${i}`}>{['A','국','법','행','한'][i]}</span><b>{s}</b><strong>{fmt(mins)}</strong></div><div className="large-bar"><i style={{width:`${Math.min(weekMinutes?mins/weekMinutes*100:0,100)}%`}}/></div></div>})}</div></div></>}
      {tab === '설정' && <><div className="page-title"><div className="eyebrow">PREFERENCES</div><h1>설정</h1><p>나의 수험 계획과 데이터를 관리해.</p></div><section className="panel connection-panel"><div className="panel-heading"><div><div className="eyebrow">SUPABASE</div><h2>기기 간 기록 동기화</h2></div><span className={`connection-status ${syncStatus}`}>{syncStatus==='synced'?'연결됨':syncStatus==='syncing'?'동기화 중':syncStatus==='error'?'확인 필요':supabaseConfigured?'로그인 전':'설정 필요'}</span></div>{!supabaseConfigured?<div className="connection-copy"><p>Vercel 프로젝트 환경변수에 아래 두 항목을 추가하고 새 배포를 만들어줘.</p><code>VITE_SUPABASE_URL</code><code>VITE_SUPABASE_PUBLISHABLE_KEY</code><small>Supabase 프로젝트 URL과 Publishable key를 사용해. Secret 또는 service_role 키는 넣지 마.</small></div>:authUser&&authMode==='set-password'?<form className="connection-form" onSubmit={updatePassword}><p>새 비밀번호를 정해줘. 이메일 링크 인증이 완료된 계정에 적용돼.</p><label>새 비밀번호<input type="password" required minLength={8} autoComplete="new-password" value={authPassword} onChange={event=>setAuthPassword(event.target.value)}/></label><label>새 비밀번호 확인<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)}/></label><button className="primary-button" type="submit" disabled={authBusy}>{authBusy?'저장 중':'비밀번호 저장'}</button></form>:authUser?<div className="connection-account"><p><b>{authUser.email}</b> 계정으로 기록을 동기화하고 있어.</p><p>현재 상태: {syncStatus==='synced'?'모든 기록이 저장됐어.':syncStatus==='syncing'?'기록을 저장하는 중이야.':syncStatus==='error'?'동기화 오류가 있어. SQL 적용과 네트워크를 확인해줘.':'연결을 준비 중이야.'}</p><button className="export-button" onClick={signOut}><LogOut size={15}/> 로그아웃</button></div>:<div className="connection-form"><p>{authMode==='signup'?'이메일과 비밀번호로 계정을 만들자. 이메일 확인이 켜져 있으면 확인 메일 링크를 눌러야 가입이 완료돼.':authMode==='reset'?'가입한 이메일을 입력하면 비밀번호 재설정 링크를 보내줄게.':'가입한 이메일과 비밀번호를 입력해 로그인해.'}</p><form onSubmit={authMode==='signup'?signUpWithPassword:authMode==='reset'?sendPasswordReset:signInWithPassword}><label>이메일 주소<input type="email" required autoComplete="email" placeholder="name@example.com" value={authEmail} onChange={event=>setAuthEmail(event.target.value)}/></label>{authMode!=='reset'&&<label>비밀번호<input type="password" required minLength={authMode==='signup'?8:1} autoComplete={authMode==='signup'?'new-password':'current-password'} value={authPassword} onChange={event=>setAuthPassword(event.target.value)}/></label>}{authMode==='signup'&&<label>비밀번호 확인<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)}/></label>}<button className="primary-button" type="submit" disabled={authBusy}>{authBusy?'잠시만…':authMode==='signup'?'가입하기':authMode==='reset'?'재설정 메일 받기':'로그인'}</button></form><div className="auth-mode-links">{authMode==='login'?<><button type="button" onClick={()=>{setAuthMode('signup');setAuthMessage('');}}>새 계정 만들기</button><button type="button" onClick={()=>{setAuthMode('reset');setAuthMessage('');}}>비밀번호 잊어버렸어</button></>:<button type="button" onClick={()=>{setAuthMode('login');setAuthMessage('');}}>로그인으로 돌아가기</button>}</div></div>}{authMessage&&<p className="auth-message" role="status">{authMessage}</p>}</section><div className="panel settings-panel"><div className="setting-row"><div className="setting-icon"><Target size={18}/></div><div><b>목표 시험</b><small>2027 제주 지방직 9급 일반행정</small></div><span className="setting-value">2027년</span></div><div className="setting-row"><div className="setting-icon"><Clock3 size={18}/></div><div><b>이번 주 공부 목표</b><small>기본이론 강의 배정 + 영단어 1시간씩</small></div><span className="setting-value">{fmtHours(weekTargetHours)}시간</span></div><div className="setting-row"><div className="setting-icon"><BriefcaseBusiness size={18}/></div><div><b>근무 일정</b><small>월–수 20:00–24:00 · 11/12·13 추가 근무 · 11/20 16:00–20:00</small></div><span className="setting-value">11월</span></div></div><div className="panel settings-panel"><div className="panel-heading"><div><div className="eyebrow">DATA</div><h2>내 기록</h2></div></div><p className="settings-copy">현재 기록은 이 브라우저에 자동 저장돼. 다른 기기에서도 쓰려면 Supabase 연결이 필요해.</p><button className="export-button" onClick={()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='합격기록장-백업.json';a.click();URL.revokeObjectURL(a.href);}}>기록 백업 다운로드 <ArrowRight size={15}/></button></div></>}
      </div><footer className="footer"><span>합격 기록장 <i>·</i> 하루씩 쌓는 나의 합격 기록</span><span>STAY STEADY, KEEP GOING.</span></footer></main>
      {mobileMenuOpen&&<div className="sidebar-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)setMobileMenuOpen(false)}}/>}
      <nav className="mobile-nav">{menu.map(({label,icon:Icon})=><button className={tab===label?'selected':''} key={label} onClick={()=>setTab(label)}><Icon size={19}/><small>{label}</small></button>)}</nav>
      {modal && <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)setModal('')}}><div className="modal"><div className="modal-head"><div><div className="eyebrow">{modal==='session'?'STUDY LOG':'WALKING ROUTE'}</div><h2>{modal==='session'?'공부 기록 추가':'이동 경로 추가'}</h2></div><button className="icon-button" onClick={()=>setModal('')}><X size={18}/></button></div>{modal==='session'?<form onSubmit={addSession}><label>과목<select value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})}>{subjects.map(s=><option key={s}>{s}</option>)}</select></label><label>학습 종류<select value={form.kind} onChange={e=>setForm({...form,kind:e.target.value})}><option>복습·문제풀이</option><option>인강 시청</option><option>단어 암기</option><option>모의고사</option></select></label><label>공부 시간<select value={form.minutes} onChange={e=>setForm({...form,minutes:e.target.value})}>{[25,30,45,60,90,120,150,180].map(n=><option value={n} key={n}>{n<60?`${n}분`:`${Math.floor(n/60)}시간${n%60?` ${n%60}분`:''}`}</option>)}</select></label><label>오늘 공부한 내용 <textarea placeholder="예: 행정법 기본강의 3강, 처분성 기출 10문제" value={form.memo} onChange={e=>setForm({...form,memo:e.target.value})}/></label><button className="primary-button submit-button" type="submit"><Check size={16}/> 기록 저장</button></form>:<form onSubmit={addTrip}><label>이동 경로<input required placeholder="예: 집 → 도서관" value={tripForm.route} onChange={e=>setTripForm({...tripForm,route:e.target.value})}/></label><label>소요 시간<select value={tripForm.minutes} onChange={e=>setTripForm({...tripForm,minutes:e.target.value})}>{[2,5,9,10,12,13,15,20,25,30,40,60].map(n=><option value={n} key={n}>{n}분</option>)}</select></label><label>메모<input value={tripForm.note} onChange={e=>setTripForm({...tripForm,note:e.target.value})}/></label><button className="primary-button submit-button" type="submit"><Check size={16}/> 이동 기록 저장</button></form>}</div></div>}{toast&&<div className="toast"><Check size={15}/>{toast}</div>}
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
  add('짧은 휴식','눈과 몸을 쉬어줘','',30,'break');
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
function RecordRow({item,onDelete}){return <div className="record-row"><div className={`record-subject ${subjects.indexOf(item.subject)>=0?`color-${subjects.indexOf(item.subject)}`:''}`}>{item.subject==='영어'?'A':item.subject.slice(0,1)}</div><div className="record-detail"><b>{item.subject} <span>· {item.kind}</span></b><small>{item.memo||'기록한 공부 시간'}</small></div><div className="record-time"><b>{fmt(Number(item.minutes))}</b><small>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(new Date(item.date+'T00:00:00'))}</small></div><button className="delete-button" aria-label="기록 삭제" onClick={()=>onDelete(item.at)}><X size={15}/></button></div>}
export default App;
