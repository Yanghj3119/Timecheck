import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CalendarDays, ChartNoAxesColumn, Clock3, Coffee, Home, MapPin, Plus, Settings2, Sparkles, Target, Train, X, Check, ChevronLeft, ChevronRight, ArrowRight, BriefcaseBusiness, Cloud, CloudOff, LogOut } from 'lucide-react';
import { supabase, supabaseConfigured } from './lib/supabase.js';
import { addLocalIds, mergeStudyData, readRemoteData, writeRemoteData } from './lib/sync.js';

const subjects = ['영어', '국어', '행정법', '행정학'];
const initialCourses = [
  { id: 'kor-basic', subject: '국어', title: '[2027] 배영표 국어 기본이론', total: 64, completed: 13 },
  { id: 'eng-basic', subject: '영어', title: '[2027] 헤더진 영어 기본이론', total: 60, completed: 11 },
  { id: 'admin-basic', subject: '행정학', title: '[2027] 이광호 행정학개론 기본이론', total: 64, completed: 2 },
  { id: 'law-basic', subject: '행정법', title: '[2027] 이재준 행정법총론 기본이론', total: 67, completed: 7 },
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
const load = () => { try { const saved = JSON.parse(localStorage.getItem('pass-note') || '{}'); return { ...seed, ...saved, courses: saved.courses ? saved.courses.filter(course => coreCourseIds.has(course.id)) : initialCourses }; } catch { return seed; } };
const todayKey = () => new Intl.DateTimeFormat('sv-SE').format(new Date());
const fmt = (mins) => `${Math.floor(mins / 60)}시간 ${mins % 60}분`;
const studyDate = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return d; };
const dateKey = (d) => new Intl.DateTimeFormat('sv-SE').format(d);
const dayName = (d) => weekdays[(d.getDay() + 6) % 7];
const lecturePlanStart = new Date(2026, 10, 9);
const lecturePlanDays = 30;

function buildLecturePlan(courses) {
  const remaining = courses.map(course => Math.max(0, Number(course.total) - Number(course.completed)));
  const total = remaining.reduce((sum, count) => sum + count, 0);
  if (!total) return [];
  const firstDayCount = Math.min(8, total);
  const rest = total - firstDayCount;
  const base = Math.floor(rest / (lecturePlanDays - 1));
  const extra = rest % (lecturePlanDays - 1);
  const quotas = [firstDayCount, ...Array.from({ length: lecturePlanDays - 1 }, (_, i) => base + (Math.floor((i + 1) * extra / 29) > Math.floor(i * extra / 29) ? 1 : 0))];
  const assigned = courses.map(() => 0);
  const days = [];
  let slot = 0;
  quotas.forEach((quota, dayIndex) => {
    const counts = courses.map(() => 0);
    for (let n = 0; n < quota && slot < total; n++, slot++) {
      let best = -1;
      let bestScore = -Infinity;
      courses.forEach((course, i) => {
        if (assigned[i] >= remaining[i]) return;
        const score = ((slot + 1) * remaining[i] / total) - assigned[i];
        if (score > bestScore) { best = i; bestScore = score; }
      });
      if (best >= 0) { assigned[best]++; counts[best]++; }
    }
    const date = new Date(lecturePlanStart);
    date.setDate(date.getDate() + dayIndex);
    days.push({ date, goal: counts.reduce((sum, count) => sum + count, 0), tasks: courses.map((course, i) => ({ course, count: counts[i] })).filter(task => task.count) });
  });
  return days;
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
  const [tab, setTab] = useState('오늘');
  const [modal, setModal] = useState('');
  const [weekShift, setWeekShift] = useState(0);
  const [form, setForm] = useState({ subject: '영어', kind: '복습·문제풀이', minutes: 60, memo: '' });
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
  const todayMinutes = sessionsToday.reduce((a, s) => a + Number(s.minutes), 0);
  const weekStart = useMemo(() => { const d = studyDate(weekShift * 7); d.setDate(d.getDate() - (d.getDay() + 6) % 7); d.setHours(0, 0, 0, 0); return d; }, [weekShift]);
  const weekDates = Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; });
  const weekSessions = data.sessions.filter((s) => s.date >= dateKey(weekDates[0]) && s.date <= dateKey(weekDates[6]));
  const weekMinutes = weekSessions.reduce((a, s) => a + Number(s.minutes), 0);
  const weekTargetHours = weekDates.reduce((sum, d) => sum + dayTarget(d), 0);
  const weekTargetMinutes = weekTargetHours * 60;
  const addSession = (e) => { e.preventDefault(); save({ ...data, sessions: [{ ...form, minutes: Number(form.minutes), date: todayKey(), at: new Date().toISOString() }, ...data.sessions] }); setModal(''); setToast('공부 기록을 저장했어요'); setTimeout(() => setToast(''), 2400); };
  const addTrip = (e) => { e.preventDefault(); save({ ...data, trips: [...data.trips, { ...tripForm, minutes: Number(tripForm.minutes) }] }); setTripForm({ route: '', minutes: 10, note: '도보' }); setModal(''); };
  const completeLecture = (course) => { if (course.completed >= course.total) return; const nextCourse = { ...course, completed: course.completed + 1 }; const now = new Date().toISOString(); const session = { subject: course.subject, kind: '인강 시청', courseId: course.id, minutes: 60, memo: `${course.title} · ${nextCourse.completed}강 수강 완료`, date: todayKey(), at: now }; save({ ...data, courses: data.courses.map(c => c.id === course.id ? nextCourse : c), sessions: [session, ...data.sessions] }); setToast(`${course.title} ${nextCourse.completed}강 완료 · 1시간 기록`); setTimeout(() => setToast(''), 2600); };
  const removeSession = (at) => { const removed = data.sessions.find((s) => s.at === at); const courses = removed?.courseId ? data.courses.map(c => c.id === removed.courseId ? { ...c, completed: Math.max(0, c.completed - 1) } : c) : data.courses; save({ ...data, courses, sessions: data.sessions.filter((s) => s.at !== at) }, removed ? [removed.localId || removed.at] : []); };
  const menu = [{ label: '오늘', icon: Home }, { label: '시간표', icon: CalendarDays }, { label: '인강 진도', icon: BookOpen }, { label: '공부 기록', icon: Clock3 }, { label: '통계', icon: ChartNoAxesColumn }];
  const courseCompleted = data.courses.reduce((sum,c)=>sum+Number(c.completed),0);
  const courseTotal = data.courses.reduce((sum,c)=>sum+Number(c.total),0);
  const lecturePlan = useMemo(() => buildLecturePlan(data.courses), [data.courses]);
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Sparkles size={18}/></div><div><strong>합격 기록장</strong><span>MY STUDY JOURNAL</span></div></div><div className="profile-card"><div className="avatar">수</div><div><b>나의 수험 기록</b><small>2027 제주 지방직 9급</small></div><ChevronRight size={16} className="muted"/></div><div className="side-label">MENU</div><nav>{menu.map(({label, icon: Icon}) => <button key={label} className={`nav-item ${tab === label ? 'active' : ''}`} onClick={() => setTab(label)}><Icon size={18}/>{label}{label === '오늘' && <span className="nav-dot"/>}</button>)}</nav><div className="side-label plan-label">MY GOAL</div><div className="goal-mini"><div className="goal-line"><Target size={17}/><b>주간 목표</b></div><strong>{weekTargetHours}<span>시간</span></strong><div className="mini-track"><i style={{width:`${Math.min(weekTargetMinutes ? weekMinutes / weekTargetMinutes * 100 : 0,100)}%`}}/></div><small>{fmt(weekMinutes)} 달성</small></div><div className="sidebar-bottom"><button className="nav-item" onClick={() => setTab('설정')}><Settings2 size={18}/>설정</button><div className="sync-state"><i/> {syncStatus==='synced'?'Supabase 동기화됨':syncStatus==='syncing'?'동기화 중':syncStatus==='error'?'동기화 확인 필요':supabaseConfigured?'로그인 후 동기화':'이 기기에 자동 저장'}</div></div></aside>
    <main className="main"><header className="topbar"><button className="header-brand" onClick={()=>setTab('오늘')} aria-label="합격 기록장 홈으로"><Sparkles size={17}/> 합격 기록장</button><div className="crumb">나의 학습 <span>/</span> <b>{tab}</b></div><div className="top-right"><button className={`sync-pill ${syncStatus}`} onClick={()=>setTab('설정')}><span className="sync-pill-icon">{syncStatus==='synced'?<Cloud size={15}/>:<CloudOff size={15}/>}</span>{syncStatus==='synced'?'동기화됨':syncStatus==='syncing'?'연결 중':syncStatus==='error'?'연결 확인':supabaseConfigured?'로그인 필요':'기기 저장'}</button><span className="date-pill"><CalendarDays size={15}/>{new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric',weekday:'short'}).format(new Date())}</span><div className="avatar small-avatar">수</div></div></header>
      <div className="content">{tab === '오늘' && <>
        <section className="welcome"><div><div className="eyebrow">{new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric'}).format(new Date()).toUpperCase()} · MY STUDY PLAN</div><h1>오늘도 한 걸음,<br/><em>합격에 가까워지고 있어요.</em></h1><p>꾸준히 쌓는 오늘의 공부가 내일의 실력이 됩니다.</p></div><div className="welcome-stamp"><span>2027</span><b>합격을 향해</b><small>ONE DAY AT A TIME</small></div></section>
        <section className="stat-grid"><div className="stat-card primary-stat"><div className="stat-head"><span>오늘 순공부</span><Clock3 size={17}/></div><div className="stat-value">{(todayMinutes / 60).toFixed(todayMinutes % 60 ? 1 : 0)}<small>시간</small></div><div className="stat-foot"><span className="green-chip">목표 {dayTarget(new Date())}시간</span><span>{Math.min(Math.round(todayMinutes / (dayTarget(new Date()) * 60) * 100), 100)}% 달성</span></div><div className="progress"><i style={{width:`${Math.min(todayMinutes / (dayTarget(new Date()) * 60) * 100,100)}%`}}/></div></div><div className="stat-card"><div className="stat-head"><span>이번 주 순공부</span><Target size={17}/></div><div className="stat-value">{(weekMinutes / 60).toFixed(weekMinutes % 60 ? 1 : 0)}<small>시간</small><b className="of-total">/ {weekTargetHours}시간</b></div><div className="stat-foot"><span>목표까지</span><b>{fmt(Math.max(weekTargetMinutes - weekMinutes, 0))}</b></div><div className="progress"><i className="blue-fill" style={{width:`${Math.min(weekTargetMinutes ? weekMinutes / weekTargetMinutes * 100 : 0,100)}%`}}/></div></div><div className="stat-card"><div className="stat-head"><span>이번 주 기록</span><BookOpen size={17}/></div><div className="stat-value">{weekSessions.length}<small>회</small></div><div className="stat-foot"><span>가장 많이 공부한 과목</span><b>{topSubject(weekSessions)}</b></div><div className="subject-dots">{subjects.map((s,i)=><i key={s} style={{background:['#ce885a','#647d72','#7480a4','#cfb56d'][i]}}/>)}</div></div></section>
        <div className="shift-notice"><BriefcaseBusiness size={16}/><span><b>11월 추가 근무</b> · 9일(월) 16:00–20:00, 20일(금) 16:00–20:00</span></div>
        <section className="dashboard-grid"><div className="panel schedule-panel"><div className="panel-heading"><div><div className="eyebrow">YOUR PLAN</div><h2>오늘의 시간표</h2></div><button className="text-button" onClick={()=>setTab('시간표')}>주간 시간표 <ArrowRight size={15}/></button></div><div className="schedule-list">{todaySchedule(new Date()).map((item,i)=><div className={`schedule-row ${item.type}`} key={i}><div className="time-col">{item.time}</div><div className="timeline"><i/></div><div className="schedule-info"><div className="schedule-title">{item.title}{item.tag && <span className={`tag ${item.type}`}>{item.tag}</span>}</div><small>{item.sub}</small></div>{item.type==='study' ? <span className="subject-pill">{item.subject}</span> : item.type==='work' ? <BriefcaseBusiness size={16} className="schedule-icon"/> : <Coffee size={16} className="schedule-icon"/>}</div>)}</div><div className="schedule-note"><Sparkles size={15}/> 월·화·수는 20:00–24:00 편의점 근무가 있어요.</div></div>
        <div className="panel subject-panel"><div className="panel-heading"><div><div className="eyebrow">SUBJECT BALANCE</div><h2>과목별 학습</h2></div><button className="icon-button" onClick={()=>setTab('통계')}><ArrowRight size={17}/></button></div><div className="subject-list">{subjects.map((s,i)=>{const mins=weekSessions.filter(x=>x.subject===s).reduce((a,x)=>a+Number(x.minutes),0); return <div className="subject-row" key={s}><span className={`subject-icon color-${i}`}>{['A','국','법','행','한'][i]}</span><b>{s}</b><div className="subject-bar"><i style={{width:`${Math.min(mins/600*100,100)}%`}}/></div><small>{fmt(mins)}</small></div>})}</div><button className="wide-add" onClick={()=>setModal('session')}><Plus size={16}/> 공부 기록 추가</button></div></section>
        <section className="bottom-grid"><div className="panel recent-panel"><div className="panel-heading"><div><div className="eyebrow">LECTURE PROGRESS</div><h2>인강 진도</h2></div><button className="text-button" onClick={()=>setTab('인강 진도')}>전체 강의 <ArrowRight size={15}/></button></div><div className="course-mini-summary"><b>{courseCompleted}<small> / {courseTotal}강</small></b><span>전체 강의 진도 · 1강 약 1시간</span><div className="progress"><i style={{width:`${courseTotal?courseCompleted/courseTotal*100:0}%`}}/></div></div>{data.courses.filter(c=>c.completed<c.total).slice(0,2).map(c=><div className="mini-course" key={c.id}><span>{c.subject}</span><b>{c.title}</b><small>{c.completed}/{c.total}강</small><button onClick={()=>completeLecture(c)} aria-label={`${c.title} 다음 강의 완료`}><Plus size={14}/></button></div>)}</div><div className="panel route-panel"><div className="panel-heading"><div><div className="eyebrow">WALKING ROUTES</div><h2>이동 시간 기록</h2></div><button className="icon-button" onClick={()=>setModal('trip')}><Plus size={17}/></button></div><div className="route-list">{data.trips.slice(0,4).map((t,i)=><div className="route-row" key={i}><span className="route-icon"><MapPin size={15}/></span><div><b>{t.route}</b><small>{t.note}</small></div><strong>{t.minutes}<small>분</small></strong></div>)}</div><div className="route-hint"><Train size={14}/> 이동 시간은 순공부 시간에서 제외돼요.</div></div></section>
      </>}
      {tab === '시간표' && <><div className="page-title"><div className="eyebrow">WEEKLY ROUTINE</div><h1>주간 시간표</h1><p>이번 주 {weekTargetHours}시간 목표 · 기본이론 완강 기간에는 하루 7–8시간 강의 시청</p></div><div className="week-switch"><button className="icon-button" onClick={()=>setWeekShift(weekShift-1)}><ChevronLeft size={18}/></button><b>{new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[0])} – {new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric'}).format(weekDates[6])}</b><button className="icon-button" onClick={()=>setWeekShift(weekShift+1)}><ChevronRight size={18}/></button><button className="today-button" onClick={()=>setWeekShift(0)}>이번 주</button></div><div className="panel weekly-table"><div className="week-head"><span>요일</span><span>학습 계획</span><span>순공 목표</span><span>실제 기록</span></div>{weekDates.map((d,i)=>{const mins=weekSessions.filter(s=>s.date===dateKey(d)).reduce((a,s)=>a+Number(s.minutes),0);const goal=dayTarget(d);const date=dateKey(d);return <div className={`week-row ${date===todayKey()?'is-today':''}`} key={i}><div className="week-day"><b>{weekdays[i]}</b><small>{d.getDate()}일</small>{date===todayKey()&&<i>오늘</i>}</div><div className="week-plan"><span className="tiny-subject">영어</span><span className="tiny-subject">{i===6?'주간 복습':'국어 · 행정법 · 행정학(지방행정)'}</span>{i<3&&<span className="work-tag"><BriefcaseBusiness size={12}/> 20:00–24:00 근무</span>}{date==='2026-11-09'&&<span className="work-tag"><BriefcaseBusiness size={12}/> 추가 16:00–20:00</span>}{date==='2026-11-20'&&<span className="work-tag"><BriefcaseBusiness size={12}/> 추가 16:00–20:00</span>}</div><div className="week-target">{goal}시간</div><div className="week-actual"><div className="small-progress"><i style={{width:`${Math.min(mins/(goal*60)*100,100)}%`}}/></div><span>{mins ? fmt(mins) : '—'}</span></div></div>})}<div className="week-total"><b>주간 합계</b><span>영어 매일 · 일요일 복습</span><strong>{weekDates.reduce((sum,d)=>sum+dayTarget(d),0)}시간</strong><strong>{fmt(weekMinutes)}</strong></div></div><div className="info-banner"><Sparkles size={18}/><div><b>기본이론 남은 강의</b><span>영어 49강 · 국어 51강 · 행정법 60강 · 행정학 62강</span></div></div><div className="info-banner"><MapPin size={18}/><div><b>이동시간은 따로 기록해</b><span>집–도서관 9분 · 도서관–편의점 13분 · 편의점–스터디카페 13분 · 스터디카페–집 2분</span></div></div></>}
      {tab === '공부 기록' && <><div className="page-title page-title-row"><div><div className="eyebrow">STUDY LOG</div><h1>공부 기록</h1><p>강의 시청과 복습·문제풀이 시간을 구분해 기록해요.</p></div><button className="primary-button" onClick={()=>setModal('session')}><Plus size={17}/> 기록 추가</button></div><div className="record-summary"><div><span>이번 주 순공부</span><b>{fmt(weekMinutes)}</b></div><div><span>기록 횟수</span><b>{weekSessions.length}회</b></div><div><span>이번 주 목표</span><b>{weekTargetHours}시간</b></div></div><div className="panel logs-panel"><div className="panel-heading"><div><div className="eyebrow">THIS WEEK</div><h2>기록 목록</h2></div><span className="record-count">{weekSessions.length}개 기록</span></div>{weekSessions.length ? <div className="record-list full-record-list">{weekSessions.map(s=><RecordRow key={s.at} item={s} onDelete={removeSession}/>)}</div>:<div className="empty-state"><div className="empty-icon"><BookOpen size={20}/></div><b>아직 기록이 없어요</b><span>첫 공부 기록을 추가해 보세요.</span></div>}</div></>}
      {tab === '인강 진도' && <><div className="page-title page-title-row"><div><div className="eyebrow">LECTURE TRACKER</div><h1>인강 진도</h1><p>기본이론 4개 과정만 한 달 일정에 넣었어. 강의 1개는 약 1시간으로 계산해.</p></div><div className="lecture-total"><b>{courseCompleted}<small> / {courseTotal}강</small></b><span>{courseTotal-courseCompleted}강 남음 · 약 {courseTotal-courseCompleted}시간</span></div></div><section className="panel lecture-plan-panel"><div className="lecture-plan-head"><div><div className="eyebrow">NOV 9 – DEC 8</div><h2>기본이론 30일 완강 일정</h2><p>남은 {courseTotal-courseCompleted}강 · 하루 평균 {Math.floor((courseTotal-courseCompleted)/30)}시간 {Math.round((courseTotal-courseCompleted)%30*60/30)}분. 근무 시간을 제외하고 배분했어.</p></div><span className="lecture-plan-total">하루 약 7–8시간</span></div><div className="lecture-plan-list">{lecturePlan.map(day=>{const key=dateKey(day.date);return <article className="lecture-plan-day" key={key}><div className="lecture-plan-date"><b>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric',weekday:'short'}).format(day.date)}</b><span>{day.goal}강 <i>· 약 {day.goal}시간</i></span></div><div className="lecture-plan-tasks">{day.tasks.map(({course,count})=><span key={course.id}><b>{course.subject}</b>{course.title.replace(/^\[\d+\]\s*/, '')} · {count}강</span>)}</div>{(key==='2026-11-09'||key==='2026-11-20'||(day.date.getDay()>=1&&day.date.getDay()<=3))&&<div className="lecture-plan-work"><BriefcaseBusiness size={14}/>{key==='2026-11-09'?'추가 근무 16:00–20:00 · 정기 근무 20:00–24:00':key==='2026-11-20'?'추가 근무 16:00–20:00':'정기 근무 20:00–24:00'}</div>}</article>})}</div><p className="lecture-plan-note">강의 시간은 1강당 약 1시간으로 계산했어. 월·화·수 근무와 11월 9일·20일 추가 근무를 표시했어. 이 일정은 강의 시청만 포함하고 복습·문제풀이는 별도야.</p></section><div className="course-subject-tabs"><span>기본이론 {data.courses.length}개</span><span>남은 수강 시간 약 {courseTotal-courseCompleted}시간</span></div>{subjects.filter(s=>data.courses.some(c=>c.subject===s)).map((subject,index)=><section className="panel course-group" key={subject}><div className="course-group-head"><span className={`subject-icon color-${subjects.indexOf(subject)}`}>{['영어','국어','행정법','행정학','한국사'].indexOf(subject)===0?'A':subject.slice(0,1)}</span><div><b>{subject}</b><small>{data.courses.filter(c=>c.subject===subject).reduce((a,c)=>a+c.completed,0)} / {data.courses.filter(c=>c.subject===subject).reduce((a,c)=>a+c.total,0)}강 수강</small></div></div>{data.courses.filter(c=>c.subject===subject).map(course=>{const pct=Math.round(course.completed/course.total*100);return <div className="course-row" key={course.id}><div className="course-info"><div className="course-name"><b>{course.title}</b>{course.completed===course.total&&<span className="complete-tag">완강</span>}</div><div className="course-progress"><i style={{width:`${pct}%`}}/></div></div><div className="course-count"><b>{course.total}강</b><small>{course.completed}강 수강</small></div><div className="course-actions"><button className="lecture-complete" disabled={course.completed>=course.total} onClick={()=>completeLecture(course)}><Plus size={14}/> 1강 완료</button></div></div>})}</section>)}</>}
      {tab === '통계' && <><div className="page-title"><div className="eyebrow">YOUR PROGRESS</div><h1>학습 통계</h1><p>시간보다 중요한 건 꾸준히 쌓이는 실력이에요.</p></div><div className="analytics-top"><div className="panel analytic-total"><div className="eyebrow">THIS WEEK STUDY TIME</div><b>{fmt(weekMinutes)}</b><span>목표 {weekTargetHours}시간 중 {Math.round((weekTargetMinutes ? weekMinutes/weekTargetMinutes*100 : 0))}% 달성</span><div className="progress"><i style={{width:`${Math.min((weekTargetMinutes ? weekMinutes/weekTargetMinutes*100 : 0),100)}%`}}/></div></div><div className="panel analytic-total soft"><div className="eyebrow">STUDY SESSIONS</div><b>{weekSessions.length}<small>회</small></b><span>이번 주 학습 기록 횟수</span><div className="spark-bars">{weekDates.map((d,i)=>{const m=weekSessions.filter(s=>s.date===dateKey(d)).reduce((a,s)=>a+Number(s.minutes),0);return <i key={i} style={{height:`${Math.max(m/540*100,6)}%`}} title={`${weekdays[i]} ${fmt(m)}`}/>})}</div></div></div><div className="panel analytics-panel"><div className="panel-heading"><div><div className="eyebrow">BY SUBJECT</div><h2>과목별 공부 시간</h2></div></div><div className="analytics-subjects">{subjects.map((s,i)=>{const mins=weekSessions.filter(x=>x.subject===s).reduce((a,x)=>a+Number(x.minutes),0);return <div className="analytics-subject" key={s}><div><span className={`subject-icon color-${i}`}>{['A','국','법','행','한'][i]}</span><b>{s}</b><strong>{fmt(mins)}</strong></div><div className="large-bar"><i style={{width:`${Math.min(weekMinutes?mins/weekMinutes*100:0,100)}%`}}/></div></div>})}</div></div></>}
      {tab === '설정' && <><div className="page-title"><div className="eyebrow">PREFERENCES</div><h1>설정</h1><p>나의 수험 계획과 데이터를 관리해.</p></div><section className="panel connection-panel"><div className="panel-heading"><div><div className="eyebrow">SUPABASE</div><h2>기기 간 기록 동기화</h2></div><span className={`connection-status ${syncStatus}`}>{syncStatus==='synced'?'연결됨':syncStatus==='syncing'?'동기화 중':syncStatus==='error'?'확인 필요':supabaseConfigured?'로그인 전':'설정 필요'}</span></div>{!supabaseConfigured?<div className="connection-copy"><p>Vercel 프로젝트 환경변수에 아래 두 항목을 추가하고 새 배포를 만들어줘.</p><code>VITE_SUPABASE_URL</code><code>VITE_SUPABASE_PUBLISHABLE_KEY</code><small>Supabase 프로젝트 URL과 Publishable key를 사용해. Secret 또는 service_role 키는 넣지 마.</small></div>:authUser&&authMode==='set-password'?<form className="connection-form" onSubmit={updatePassword}><p>새 비밀번호를 정해줘. 이메일 링크 인증이 완료된 계정에 적용돼.</p><label>새 비밀번호<input type="password" required minLength={8} autoComplete="new-password" value={authPassword} onChange={event=>setAuthPassword(event.target.value)}/></label><label>새 비밀번호 확인<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)}/></label><button className="primary-button" type="submit" disabled={authBusy}>{authBusy?'저장 중':'비밀번호 저장'}</button></form>:authUser?<div className="connection-account"><p><b>{authUser.email}</b> 계정으로 기록을 동기화하고 있어.</p><p>현재 상태: {syncStatus==='synced'?'모든 기록이 저장됐어.':syncStatus==='syncing'?'기록을 저장하는 중이야.':syncStatus==='error'?'동기화 오류가 있어. SQL 적용과 네트워크를 확인해줘.':'연결을 준비 중이야.'}</p><button className="export-button" onClick={signOut}><LogOut size={15}/> 로그아웃</button></div>:<div className="connection-form"><p>{authMode==='signup'?'이메일과 비밀번호로 계정을 만들자. 이메일 확인이 켜져 있으면 확인 메일 링크를 눌러야 가입이 완료돼.':authMode==='reset'?'가입한 이메일을 입력하면 비밀번호 재설정 링크를 보내줄게.':'가입한 이메일과 비밀번호를 입력해 로그인해.'}</p><form onSubmit={authMode==='signup'?signUpWithPassword:authMode==='reset'?sendPasswordReset:signInWithPassword}><label>이메일 주소<input type="email" required autoComplete="email" placeholder="name@example.com" value={authEmail} onChange={event=>setAuthEmail(event.target.value)}/></label>{authMode!=='reset'&&<label>비밀번호<input type="password" required minLength={authMode==='signup'?8:1} autoComplete={authMode==='signup'?'new-password':'current-password'} value={authPassword} onChange={event=>setAuthPassword(event.target.value)}/></label>}{authMode==='signup'&&<label>비밀번호 확인<input type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={event=>setConfirmPassword(event.target.value)}/></label>}<button className="primary-button" type="submit" disabled={authBusy}>{authBusy?'잠시만…':authMode==='signup'?'가입하기':authMode==='reset'?'재설정 메일 받기':'로그인'}</button></form><div className="auth-mode-links">{authMode==='login'?<><button type="button" onClick={()=>{setAuthMode('signup');setAuthMessage('');}}>새 계정 만들기</button><button type="button" onClick={()=>{setAuthMode('reset');setAuthMessage('');}}>비밀번호 잊어버렸어</button></>:<button type="button" onClick={()=>{setAuthMode('login');setAuthMessage('');}}>로그인으로 돌아가기</button>}</div></div>}{authMessage&&<p className="auth-message" role="status">{authMessage}</p>}</section><div className="panel settings-panel"><div className="setting-row"><div className="setting-icon"><Target size={18}/></div><div><b>목표 시험</b><small>2027 제주 지방직 9급 일반행정</small></div><span className="setting-value">2027년</span></div><div className="setting-row"><div className="setting-icon"><Clock3 size={18}/></div><div><b>주간 순공 목표</b><small>월 6 · 화 6 · 수 6 · 목 9 · 금 9 · 토 9 · 일 5시간</small></div><span className="setting-value">50시간</span></div><div className="setting-row"><div className="setting-icon"><BriefcaseBusiness size={18}/></div><div><b>근무 일정</b><small>월–수 20:00–24:00 · 11/9 추가 16:00–20:00 · 11/20 추가 16:00–20:00</small></div><span className="setting-value">11월</span></div><div className="setting-row"><div className="setting-icon"><MapPin size={18}/></div><div><b>이동 시간</b><small>순공부 시간과 분리해서 관리</small></div><span className="setting-value">{data.trips.length}개 경로</span></div></div><div className="panel settings-panel"><div className="panel-heading"><div><div className="eyebrow">DATA</div><h2>내 기록</h2></div></div><p className="settings-copy">현재 기록은 이 브라우저에 자동 저장돼. 다른 기기에서도 쓰려면 Supabase 연결이 필요해.</p><button className="export-button" onClick={()=>{const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='합격기록장-백업.json';a.click();URL.revokeObjectURL(a.href);}}>기록 백업 다운로드 <ArrowRight size={15}/></button></div></>}
      </div><footer className="footer"><span>합격 기록장 <i>·</i> 하루씩 쌓는 나의 합격 기록</span><span>STAY STEADY, KEEP GOING.</span></footer></main>
      <nav className="mobile-nav">{menu.map(({label,icon:Icon})=><button className={tab===label?'selected':''} key={label} onClick={()=>setTab(label)}><Icon size={19}/><small>{label}</small></button>)}</nav>
      {modal && <div className="modal-backdrop" onMouseDown={(e)=>{if(e.target===e.currentTarget)setModal('')}}><div className="modal"><div className="modal-head"><div><div className="eyebrow">{modal==='session'?'STUDY LOG':'WALKING ROUTE'}</div><h2>{modal==='session'?'공부 기록 추가':'이동 경로 추가'}</h2></div><button className="icon-button" onClick={()=>setModal('')}><X size={18}/></button></div>{modal==='session'?<form onSubmit={addSession}><label>과목<select value={form.subject} onChange={e=>setForm({...form,subject:e.target.value})}>{subjects.map(s=><option key={s}>{s}</option>)}</select></label><label>학습 종류<select value={form.kind} onChange={e=>setForm({...form,kind:e.target.value})}><option>복습·문제풀이</option><option>인강 시청</option><option>단어 암기</option><option>모의고사</option></select></label><label>공부 시간<select value={form.minutes} onChange={e=>setForm({...form,minutes:e.target.value})}>{[25,30,45,60,90,120,150,180].map(n=><option value={n} key={n}>{n<60?`${n}분`:`${Math.floor(n/60)}시간${n%60?` ${n%60}분`:''}`}</option>)}</select></label><label>오늘 공부한 내용 <textarea placeholder="예: 행정법 기본강의 3강, 처분성 기출 10문제" value={form.memo} onChange={e=>setForm({...form,memo:e.target.value})}/></label><button className="primary-button submit-button" type="submit"><Check size={16}/> 기록 저장</button></form>:<form onSubmit={addTrip}><label>이동 경로<input required placeholder="예: 집 → 도서관" value={tripForm.route} onChange={e=>setTripForm({...tripForm,route:e.target.value})}/></label><label>소요 시간<select value={tripForm.minutes} onChange={e=>setTripForm({...tripForm,minutes:e.target.value})}>{[2,5,9,10,12,13,15,20,25,30,40,60].map(n=><option value={n} key={n}>{n}분</option>)}</select></label><label>메모<input value={tripForm.note} onChange={e=>setTripForm({...tripForm,note:e.target.value})}/></label><button className="primary-button submit-button" type="submit"><Check size={16}/> 이동 기록 저장</button></form>}</div></div>}{toast&&<div className="toast"><Check size={15}/>{toast}</div>}
    </div>
}
function dayTarget(d){const key=dateKey(d);const start=dateKey(lecturePlanStart);const last='2026-12-08';if(key<start||key>last)return baseHours[(d.getDay()+6)%7];const index=Math.round((new Date(`${key}T00:00:00`)-new Date(`${start}T00:00:00`))/86400000);if(index===0)return 8;return 7+(Math.floor(index*11/29)>Math.floor((index-1)*11/29)?1:0)}
function topSubject(sessions){if(!sessions.length)return '—';return subjects.map(s=>[s,sessions.filter(x=>x.subject===s).reduce((a,x)=>a+Number(x.minutes),0)]).sort((a,b)=>b[1]-a[1])[0][0]}
function todaySchedule(d){const key=dateKey(d),day=(d.getDay()+6)%7;let schedule;if(key==='2026-11-09'){schedule=[['영어 단어 · 독해','매일 루틴 · 2시간','영어','08:45–10:45','study'],['국어 독해 · 문법','1시간','국어','10:45–11:45','study'],['점심 및 휴식','잠시 쉬어가도 괜찮아','','11:45–12:45','break'],['행정법 기본강의 · 복습','1시간 30분','행정법','12:45–14:15','study'],['행정학 기본강의','1시간 30분','행정학','14:15–15:45','study'],['추가 근무','편의점 근무','', '16:00–20:00','work'],['편의점 근무','기존 월요일 근무','', '20:00–24:00','work']];}else if(key==='2026-11-20'){schedule=[['영어 루틴 · 국어 독해','집중 학습 · 3시간','영어·국어','07:00–10:00','study'],['휴식','잠시 쉬어가도 괜찮아','','10:00–10:30','break'],['행정법 기본강의 · 복습','집중 학습 · 3시간','행정법','10:30–13:30','study'],['점심 및 이동 준비','출근 전 여유시간','','13:30–14:00','break'],['행정학 지방행정 정리','집중 학습 · 1시간','행정학','14:00–15:00','study'],['이동 및 근무 준비','16시 근무 시작 전 여유시간','','15:00–16:00','break'],['추가 근무','편의점 근무','','16:00–20:00','work']];}else if(day===6){schedule=[['주간 복습 · 영어 루틴','이번 주 복습과 영어 단어 · 3시간','영어','09:15–12:15','study'],['점심 및 휴식','잠시 쉬어가도 괜찮아','','12:15–13:15','break'],['부족한 과목 보충','이번 주 진도 정리 · 2시간','복습','13:15–15:15','study']];}else if(key>='2026-11-16'&&key<='2026-11-22'&&(day===3||day===5)){schedule=[['영어 루틴 · 국어 독해','집중 학습 1차 · 3시간','영어·국어','07:45–10:45','study'],['휴식','잠시 쉬어가도 괜찮아','','10:45–11:15','break'],['행정법 기본강의 · 복습','집중 학습 2차 · 2시간','행정법','11:15–13:15','study'],['점심 및 휴식','재충전 시간','','13:15–14:15','break'],['행정학 지방행정 포함','집중 학습 3차 · 2시간 30분','행정학','14:15–16:45','study'],['휴식','오후 학습 전 재충전','','16:45–17:15','break'],['취약 과목 문제풀이','집중 학습 4차 · 2시간 30분','복습','17:15–19:45','study']];}else if(day>=3){schedule=[['영어 루틴 · 국어 독해','집중 학습 1차 · 3시간','영어·국어','09:15–12:15','study'],['점심 및 휴식','잠시 쉬어가도 괜찮아','','12:15–13:15','break'],['행정법 기본강의 · 복습','집중 학습 2차 · 3시간','행정법','13:15–16:15','study'],['휴식 및 식사','오후 집중 학습 전 재충전','','16:15–17:15','break'],['행정학 기본강의','집중 학습 3차 · 3시간','행정학','17:15–20:15','study']];}else{schedule=[['영어 단어 · 기초 문법','매일 루틴 · 1시간','영어','09:15–10:15','study'],['국어 독해 · 문법','집중 학습 1차 · 2시간','국어','10:15–12:15','study'],['점심 및 휴식','잠시 쉬어가도 괜찮아','','12:15–13:15','break'],['행정법 기본강의 · 복습','집중 학습 2차 · 2시간','행정법','13:15–15:15','study'],['행정학 기본강의','오늘의 학습 목표 · 1시간','행정학','15:15–16:15','study']];}return schedule.map(([title,sub,subject,time,type],i)=>({title,sub,subject,time,type,tag:i===0&&day!==6?'매일':''})).concat(day<3&&key!=='2026-11-09'?[{title:'편의점 근무',sub:'근무 전 이동과 준비시간 포함',time:'20:00–24:00',type:'work'}]:[])}
function RecordRow({item,onDelete}){return <div className="record-row"><div className={`record-subject ${subjects.indexOf(item.subject)>=0?`color-${subjects.indexOf(item.subject)}`:''}`}>{item.subject==='영어'?'A':item.subject.slice(0,1)}</div><div className="record-detail"><b>{item.subject} <span>· {item.kind}</span></b><small>{item.memo||'기록한 공부 시간'}</small></div><div className="record-time"><b>{fmt(Number(item.minutes))}</b><small>{new Intl.DateTimeFormat('ko-KR',{month:'numeric',day:'numeric'}).format(new Date(item.date+'T00:00:00'))}</small></div><button className="delete-button" aria-label="기록 삭제" onClick={()=>onDelete(item.at)}><X size={15}/></button></div>}
export default App;
