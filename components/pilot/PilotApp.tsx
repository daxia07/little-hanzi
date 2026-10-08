'use client';

import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronRight,
  CircleUserRound,
  ClipboardList,
  KeyRound,
  Link2,
  LockKeyhole,
  LogOut,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import ParentStoryPlan from './ParentStoryPlan';
import ParentCollectionPlan from './collection/ParentCollectionPlan';
import CollectionHome from './collection/CollectionHome';
import CollectionProgressPanel from './collection/CollectionProgressPanel';
import CollectionRegisterPanel from './collection/CollectionRegisterPanel';
import FamilyCorpusEntry from './corpus/FamilyCorpusEntry';
import CorpusOwnerEntry from './corpus/CorpusOwnerEntry';
import OperatorCorpusPanel from './corpus/OperatorCorpusPanel';
import ChildStoryPanel from './ChildStoryPanel';
import ParentStoryProgress from './ParentStoryProgress';
import storyStyles from './story/family.module.css';
import {
  lockPilotStoryControllers,
  registerPilotStoryController,
} from '@/lib/pilot-story-client';
import { createCorpusLoadPriority } from '@/lib/pilot-corpus-load-priority';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  PilotApiError,
  PilotAccount,
  PilotGrant,
  PilotMe,
  PilotRole,
  changePilotPassword,
  clearPendingSignOut,
  clearPilotPrivateState,
  createPilotAccount,
  getPilotMe,
  getPilotSession,
  grantPilotTeacher,
  hasPendingSignOut,
  linkPilotChild,
  listPilotAccounts,
  markPendingSignOut,
  resetPilotAccount,
  revokePilotTeacher,
  signInUsername,
  signOutPilot,
  setPilotAccountStatus,
  unlinkPilotChild,
} from '@/lib/pilot-client';
import styles from './pilot.module.css';
import { PilotAscentIllustration, PilotCompanion } from './illustrations';
import OperatorReviewDesk from './OperatorReviewDesk';
import OperatorOpsPanel from './ops/OperatorOpsPanel';
import opsStyles from './ops/ops.module.css';
import { lockPilotOpsControllers } from '@/lib/pilot-ops-client';
import {
  ChildLearningPanel,
  ParentLearningPanel,
  TeacherLearningPanel,
} from './PilotLearningViews';

type PilotScreen = 'login' | 'change-password' | 'home';
type SignOutState = 'idle' | 'pending' | 'failed';
type PilotExperience = 'full' | 'first-story';

function messageFor(error: unknown) {
  if (error instanceof PilotApiError) return error.message;
  return 'The pilot service could not be reached. Check the connection and retry.';
}

function displayUsername(value: string) {
  return value.replace(/@[^@\s]+\.invalid$/i, '');
}

function roleLabel(role: PilotRole) {
  return role === 'child'
    ? 'Child'
    : role === 'parent'
      ? 'Parent'
      : role === 'teacher'
        ? 'Teacher'
        : 'Operator';
}

export default function PilotApp({
  experience = 'full',
}: {
  experience?: PilotExperience;
} = {}) {
  const [screen, setScreen] = useState<PilotScreen>('login');
  const [me, setMe] = useState<PilotMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signOutState, setSignOutState] = useState<SignOutState>('idle');
  const [storageWarning, setStorageWarning] = useState('');
  const authRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const signOutStateRef = useRef<SignOutState>('idle');
  const busyRef = useRef(false);

  function setBusyState(value: boolean) {
    busyRef.current = value;
    setBusy(value);
  }

  function setSignOutStateSafe(value: SignOutState) {
    signOutStateRef.current = value;
    setSignOutState(value);
  }

  function beginAuthRequest() {
    authRequestRef.current += 1;
    return authRequestRef.current;
  }

  function isCurrentAuthRequest(requestId: number) {
    return mountedRef.current && authRequestRef.current === requestId;
  }

  function clearLocalProjection() {
    setMe(null);
    setScreen('login');
    setUsername('');
    setPassword('');
    setNewPassword('');
    setConfirmPassword('');
  }

  function clearAuthenticatedProjection() {
    setMe(null);
    setScreen('login');
  }

  async function finishPendingSignOut() {
    lockPilotStoryControllers();
    lockPilotOpsControllers();
    if (signOutStateRef.current === 'pending') return;
    const requestId = beginAuthRequest();
    setSignOutStateSafe('pending');
    setBusyState(true);
    setLoading(false);
    setError('');
    setNotice('');
    clearLocalProjection();

    const markerStored = markPendingSignOut();
    const projectionCleared = clearPilotPrivateState();
    if (!markerStored || !projectionCleared) {
      setStorageWarning(
        'This browser is blocking some private storage. Keep this tab open and finish sign-out before another person uses the device.',
      );
    } else {
      setStorageWarning('');
    }

    try {
      await signOutPilot();
      if (!isCurrentAuthRequest(requestId)) return;
      const markerCleared = clearPendingSignOut();
      const finalProjectionCleared = clearPilotPrivateState();
      setSignOutStateSafe('idle');
      setNotice(
        'The server confirmed sign-out. This shared device is ready for another invited account.',
      );
      setError('');
      if (!markerCleared || !finalProjectionCleared) {
        setStorageWarning(
          'The server confirmed sign-out, but this browser could not fully clear its private storage marker.',
        );
      } else {
        setStorageWarning('');
      }
    } catch (signOutError) {
      if (!isCurrentAuthRequest(requestId)) return;
      setSignOutStateSafe('failed');
      setError(
        `${messageFor(signOutError)} Sign-out is not confirmed; retry before another person uses this device.`,
      );
      setNotice('');
    } finally {
      if (isCurrentAuthRequest(requestId)) setBusyState(false);
    }
  }

  async function loadSignedInUser() {
    if (signOutStateRef.current !== 'idle') {
      setLoading(false);
      return;
    }
    if (hasPendingSignOut()) {
      await finishPendingSignOut();
      return;
    }
    const requestId = beginAuthRequest();
    setLoading(true);
    setError('');
    try {
      const session = await getPilotSession();
      if (!isCurrentAuthRequest(requestId)) return;
      if (hasPendingSignOut()) {
        await finishPendingSignOut();
        return;
      }
      if (!session) {
        clearAuthenticatedProjection();
        if (!clearPilotPrivateState()) {
          setStorageWarning(
            'This browser is blocking private storage cleanup. Do not use this shared device until storage access is restored.',
          );
        }
        return;
      }
      const current = await getPilotMe();
      if (!isCurrentAuthRequest(requestId)) return;
      if (hasPendingSignOut()) {
        await finishPendingSignOut();
        return;
      }
      if (
        me &&
        (me.user.id !== current.user.id ||
          me.installationId !== current.installationId)
      ) {
        lockPilotStoryControllers();
        lockPilotOpsControllers();
        clearPilotPrivateState();
      }
      setMe(current);
      setScreen(current.user.mustChangePassword ? 'change-password' : 'home');
    } catch (loadError) {
      if (!isCurrentAuthRequest(requestId)) return;
      if (hasPendingSignOut()) {
        await finishPendingSignOut();
        return;
      }
      clearAuthenticatedProjection();
      setError(messageFor(loadError));
    } finally {
      if (isCurrentAuthRequest(requestId)) setLoading(false);
    }
  }

  // The browser only keeps the HttpOnly server session. The client projection
  // is re-read after every navigation so role changes and revocations apply.
  // oxlint-disable react/react-compiler -- Session restoration is an external auth read.
  // oxlint-disable react-hooks/exhaustive-deps
  useEffect(() => {
    mountedRef.current = true;
    void loadSignedInUser();
    const revalidate = () => {
      if (signOutStateRef.current === 'idle' && !busyRef.current)
        void loadSignedInUser();
    };
    const opsAccessEnded = () => {
      lockPilotStoryControllers();
      lockPilotOpsControllers();
      clearLocalProjection();
      if (signOutStateRef.current === 'idle') void loadSignedInUser();
    };
    window.addEventListener('little-hanzi:ops-access-ended', opsAccessEnded);
    window.addEventListener('focus', revalidate);
    window.addEventListener('pageshow', revalidate);
    return () => {
      mountedRef.current = false;
      window.removeEventListener(
        'little-hanzi:ops-access-ended',
        opsAccessEnded,
      );
      window.removeEventListener('focus', revalidate);
      window.removeEventListener('pageshow', revalidate);
    };
  }, []);
  // oxlint-enable react-hooks/exhaustive-deps
  // oxlint-enable react/react-compiler

  async function handleSignIn(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password to continue.');
      return;
    }
    if (signOutStateRef.current !== 'idle') return;
    if (hasPendingSignOut()) {
      await finishPendingSignOut();
      return;
    }
    const requestId = beginAuthRequest();
    setBusyState(true);
    setError('');
    setNotice('');
    if (!clearPilotPrivateState()) {
      setStorageWarning(
        'This browser is blocking private storage cleanup. Sign-in will continue without trusting saved pilot state.',
      );
    }
    try {
      await signInUsername(username.trim(), password);
      if (!isCurrentAuthRequest(requestId)) return;
      if (hasPendingSignOut()) {
        await finishPendingSignOut();
        return;
      }
      const current = await getPilotMe();
      if (!isCurrentAuthRequest(requestId)) return;
      setMe(current);
      if (current.user.mustChangePassword) setScreen('change-password');
      else {
        setPassword('');
        setScreen('home');
      }
    } catch (signInError) {
      if (isCurrentAuthRequest(requestId)) setError(messageFor(signInError));
    } finally {
      if (isCurrentAuthRequest(requestId)) setBusyState(false);
    }
  }

  async function handlePasswordChange(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (newPassword.length < 8) {
      setError('Choose a password with at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }
    if (signOutStateRef.current !== 'idle') return;
    if (hasPendingSignOut()) {
      await finishPendingSignOut();
      return;
    }
    const requestId = beginAuthRequest();
    setBusyState(true);
    setError('');
    try {
      await changePilotPassword(password, newPassword);
      if (!isCurrentAuthRequest(requestId)) return;
      if (hasPendingSignOut()) {
        await finishPendingSignOut();
        return;
      }
      setPassword('');
      setNewPassword('');
      setConfirmPassword('');
      const current = await getPilotMe();
      if (!isCurrentAuthRequest(requestId)) return;
      setMe(current);
      setScreen(current.user.mustChangePassword ? 'change-password' : 'home');
      setNotice('Password changed. Your invited account is ready.');
    } catch (changeError) {
      if (isCurrentAuthRequest(requestId)) setError(messageFor(changeError));
    } finally {
      if (isCurrentAuthRequest(requestId)) setBusyState(false);
    }
  }

  async function handleSignOut() {
    await finishPendingSignOut();
  }

  const preserveOperatorHome = Boolean(
    loading &&
    signOutState === 'idle' &&
    me &&
    screen === 'home' &&
    me.user.role === 'operator',
  );

  if (loading && !preserveOperatorHome)
    return (
      <PilotFrame
        locked
        homeHref={
          experience === 'first-story' ? '/pilot/first-story' : '/pilot'
        }
      >
        <div className={styles.loading}>
          <div>
            <RefreshCw aria-hidden="true" />
            <p>Checking this invited account…</p>
          </div>
        </div>
      </PilotFrame>
    );

  return (
    <PilotFrame
      signedIn={Boolean(me)}
      user={me?.user}
      onSignOut={() => void handleSignOut()}
      busy={busy}
      locked={signOutState !== 'idle'}
      homeHref={experience === 'first-story' ? '/pilot/first-story' : '/pilot'}
    >
      {error && (
        <PilotAlert
          text={error}
          onRetry={
            screen === 'login' ? undefined : () => void loadSignedInUser()
          }
        />
      )}
      {notice && (
        <div className={styles.infoBand}>
          <Check size={18} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}
      {storageWarning && (
        <div className={styles.infoBand}>
          <AlertCircle size={18} aria-hidden="true" />
          <span>{storageWarning}</span>
        </div>
      )}
      {screen === 'login' && signOutState === 'idle' && (
        <LoginView
          username={username}
          password={password}
          busy={busy}
          onUsername={setUsername}
          onPassword={setPassword}
          onSubmit={(event) => void handleSignIn(event)}
        />
      )}
      {screen === 'login' && signOutState !== 'idle' && (
        <SignOutGuard
          state={signOutState}
          busy={busy}
          onRetry={() => void finishPendingSignOut()}
        />
      )}
      {screen === 'change-password' && me && (
        <PasswordChangeView
          name={me.user.name}
          currentPassword={password}
          newPassword={newPassword}
          confirmPassword={confirmPassword}
          busy={busy}
          onCurrentPassword={setPassword}
          onNewPassword={setNewPassword}
          onConfirmPassword={setConfirmPassword}
          onSubmit={(event) => void handlePasswordChange(event)}
        />
      )}
      {screen === 'home' && me && (
        <div aria-busy={loading}>
          {preserveOperatorHome && (
            <output
              className={`${styles.infoBand} ${styles.revalidationStatus}`}
            >
              Checking this operator account…
            </output>
          )}
          <div
            hidden={preserveOperatorHome}
            inert={preserveOperatorHome || undefined}
          >
            <RoleHome
              key={`${me.user.id}:${me.installationId}`}
              me={me}
              onRefresh={() => void loadSignedInUser()}
              onSignOut={() => void handleSignOut()}
              experience={experience}
            />
          </div>
        </div>
      )}
    </PilotFrame>
  );
}

function PilotFrame({
  children,
  signedIn,
  user,
  onSignOut,
  busy,
  locked,
  homeHref,
}: {
  children: React.ReactNode;
  signedIn?: boolean;
  user?: PilotMe['user'];
  onSignOut?: () => void;
  busy?: boolean;
  locked?: boolean;
  homeHref: string;
}) {
  return (
    <div
      className={`${styles.root} ${signedIn && user ? (user.role !== 'operator' ? storyStyles.ordinaryRoot : opsStyles.operatorRoot) : ''}`}
      lang="en"
    >
      <div className={styles.shell}>
        <nav className={styles.topbar} aria-label="Pilot navigation">
          <Link className={styles.brand} href={homeHref}>
            <span className={styles.brandMark} data-pilot-brand-glyph>
              字
            </span>
            <span className={styles.brandText}>
              <span className={styles.brandName}>Little Hanzi</span>
              <span className={styles.brandSub}>invited family pilot</span>
            </span>
          </Link>
          {signedIn && user ? (
            <div className={styles.topActions} data-pilot-top-actions>
              <span className={styles.status} data-state="active">
                <CircleUserRound size={15} /> {user.name} ·{' '}
                {roleLabel(user.role)}
              </span>
              <button
                className={styles.quietButton}
                onClick={onSignOut}
                disabled={busy}
              >
                <LogOut size={16} /> Sign out
              </button>
            </div>
          ) : locked ? (
            <span className={styles.smallPrint}>Sign-out in progress</span>
          ) : (
            <Link className={styles.navLink} href="/">
              Family learning
            </Link>
          )}
        </nav>
        {children}
      </div>
    </div>
  );
}

function SignOutGuard({
  state,
  busy,
  onRetry,
}: {
  state: Exclude<SignOutState, 'idle'>;
  busy: boolean;
  onRetry: () => void;
}) {
  const pending = state === 'pending';
  return (
    <main className={styles.page}>
      <section className={`${styles.surface} ${styles.authCard}`}>
        <div className={styles.roleTag}>
          <LockKeyhole size={15} /> Shared-device protection
        </div>
        <h1 className={styles.title}>
          {pending ? 'Finishing sign-out…' : 'Finish signing out'}
        </h1>
        <p>
          {pending
            ? 'The local account view is cleared. Wait for the server to confirm that this session has ended.'
            : 'The local account view is cleared, but the server has not confirmed sign-out. Retry before another person uses this device.'}
        </p>
        <div className={styles.formActions}>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={onRetry}
            disabled={busy}
          >
            {pending ? 'Signing out…' : 'Retry sign-out'} <LogOut size={17} />
          </button>
        </div>
      </section>
    </main>
  );
}

function PilotAlert({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className={styles.alert} role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <span>{text}</span>
      {onRetry && (
        <button className={styles.quietButton} onClick={onRetry}>
          <RefreshCw size={15} /> Retry
        </button>
      )}
    </div>
  );
}

function LoginView({
  username,
  password,
  busy,
  onUsername,
  onPassword,
  onSubmit,
}: {
  username: string;
  password: string;
  busy: boolean;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  onSubmit: (event: { preventDefault: () => void }) => void;
}) {
  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>A calm place for invited families</p>
          <h1 className={styles.title}>
            Listen, notice, and take the next small step.
          </h1>
          <p className={styles.lead}>
            Use the username your pilot operator gave you. Little Hanzi keeps
            each child’s learning with the right family account.
          </p>
          <div className={styles.trustRow}>
            <span>
              <ShieldCheck size={16} /> Private invited access
            </span>
            <span>
              <LockKeyhole size={16} /> Saved by role
            </span>
          </div>
        </div>
        <div className={styles.heroArt}>
          <PilotCompanion className={styles.mascotHero} preload />
        </div>
      </section>
      <section className={styles.authLayout}>
        <div className={`${styles.surface} ${styles.authCard}`}>
          <h2>Sign in</h2>
          <p>
            Your account decides which family view and learner records are
            available.
          </p>
          <form className={styles.fieldStack} onSubmit={onSubmit}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Username</span>
              <input
                className={styles.input}
                autoComplete="username"
                value={username}
                onChange={(event) => onUsername(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Password</span>
              <input
                className={styles.input}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => onPassword(event.target.value)}
              />
            </label>
            <p className={styles.formHint}>
              This pilot uses invited usernames. There is no public sign-up or
              email login.
            </p>
            <div className={styles.formActions}>
              <button
                className={styles.primaryButton}
                type="submit"
                disabled={busy}
              >
                {busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={17} />
              </button>
            </div>
          </form>
        </div>
        <div className={`${styles.surface} ${styles.authCard}`}>
          <PilotAscentIllustration className={styles.heroArt} />
          <h2>What happens next?</h2>
          <p>
            Children see their assigned learning when it is connected. Parents
            see linked children and teacher access. Teachers see only learners
            explicitly shared with them.
          </p>
          <p className={styles.smallPrint}>
            The pilot is invitation-only. A lesson assignment may remain pending
            while ownership is connected.
          </p>
          <Link
            className={styles.navLink}
            href="/design/capybara.html"
            target="_blank"
            rel="noopener"
            prefetch={false}
          >
            Meet your capybara guide · character preview{' '}
            <ArrowRight size={16} />
          </Link>
        </div>
      </section>
    </main>
  );
}

function PasswordChangeView({
  name,
  currentPassword,
  newPassword,
  confirmPassword,
  busy,
  onCurrentPassword,
  onNewPassword,
  onConfirmPassword,
  onSubmit,
}: {
  name: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  busy: boolean;
  onCurrentPassword: (value: string) => void;
  onNewPassword: (value: string) => void;
  onConfirmPassword: (value: string) => void;
  onSubmit: (event: { preventDefault: () => void }) => void;
}) {
  return (
    <main className={styles.page}>
      <section className={`${styles.surface} ${styles.authCard}`}>
        <div className={styles.roleTag}>
          <KeyRound size={15} /> First sign-in step
        </div>
        <h1 className={styles.title}>Choose a private password, {name}.</h1>
        <p>
          Invited and reset passwords must change before ordinary pilot actions
          are available. Keep this password private.
        </p>
        <form className={styles.fieldStack} onSubmit={onSubmit}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Current password</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => onCurrentPassword(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>New password</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={newPassword}
              onChange={(event) => onNewPassword(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Repeat new password</span>
            <input
              className={styles.input}
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={confirmPassword}
              onChange={(event) => onConfirmPassword(event.target.value)}
            />
          </label>
          <p className={styles.formHint}>
            Use at least 8 characters. Passwords are sent only to the server
            over the authenticated request.
          </p>
          <div className={styles.formActions}>
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={busy || !currentPassword}
            >
              {busy ? 'Saving…' : 'Save password'} <Check size={17} />
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function RoleHome({
  me,
  onRefresh,
  onSignOut,
  experience,
}: {
  me: PilotMe;
  onRefresh: () => void;
  onSignOut: () => void;
  experience: PilotExperience;
}) {
  if (experience === 'first-story' && me.user.role !== 'operator') {
    return (
      <FirstStoryHome me={me} onRefresh={onRefresh} onSignOut={onSignOut} />
    );
  }
  if (me.user.role === 'operator')
    return <OperatorHome me={me} onRefresh={onRefresh} />;
  if (me.user.role === 'parent') {
    const grantsKey =
      me.grants === undefined ? 'unavailable' : JSON.stringify(me.grants);
    return (
      <ParentHome
        key={grantsKey}
        me={me}
        onRefresh={onRefresh}
        onSignOut={onSignOut}
      />
    );
  }
  if (me.user.role === 'teacher') return <TeacherHome me={me} />;
  return <ChildHome me={me} />;
}

function FirstStoryHome({
  me,
  onRefresh,
  onSignOut,
}: {
  me: PilotMe;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const [active, setActive] = useState(false);
  if (me.user.role === 'parent') {
    return (
      <main className={styles.page} data-experience="first-story">
        <HomeHeader
          me={me}
          title="Get ready for your child's first story."
          description="Check the details, try the Mandarin sound, and approve one available story. Stay nearby while your child learns."
          showBoundary={false}
        />
        <ParentStoryPlan me={me} onSignOut={onSignOut} />
        <ParentStoryProgress me={me} />
        <button className={styles.quietButton} onClick={onRefresh}>
          <RefreshCw size={15} /> Refresh saved family records
        </button>
      </main>
    );
  }
  if (me.user.role === 'child') {
    return (
      <main className={styles.page} data-experience="first-story">
        <div hidden={active} style={{ display: active ? 'none' : undefined }}>
          <HomeHeader
            me={me}
            title={`Ready for your story, ${me.user.name}?`}
            description="Choose Start or Continue. Your parent can stay nearby while you control the story."
            showBoundary={false}
          />
        </div>
        <ChildStoryPanel me={me} onActiveChange={setActive} />
      </main>
    );
  }
  return <TeacherHome me={me} />;
}

function HomeHeader({
  me,
  title,
  description,
  showBoundary = true,
}: {
  me: PilotMe;
  title: string;
  description: string;
  showBoundary?: boolean;
}) {
  return (
    <header className={styles.pageHeader} data-pilot-home-header>
      <div>
        <p className={styles.eyebrow}>
          Invited pilot · {roleLabel(me.user.role)}
        </p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {showBoundary && (
        <span className={styles.roleTag}>
          <ShieldCheck size={15} /> Account boundary active
        </span>
      )}
    </header>
  );
}

function ChildHome({ me }: { me: PilotMe }) {
  const [ordinaryActive, setOrdinaryActive] = useState(false);
  const [source, setSource] = useState<
    'corpus' | 'collection' | 'story' | 'legacy' | null
  >(null);
  const discovered = useCallback(
    (available: boolean) =>
      setSource((current) => current ?? (available ? 'corpus' : 'legacy')),
    [],
  );
  return (
    <main className={styles.page}>
      <div
        hidden={ordinaryActive}
        style={{ display: ordinaryActive ? 'none' : undefined }}
      >
        <HomeHeader
          me={me}
          title={`Hello, ${me.user.name}.`}
          description="Your invited account keeps your learning with your own child record."
        />
      </div>
      <section
        data-pilot-legacy-layout={ordinaryActive ? undefined : true}
        className={ordinaryActive ? undefined : styles.grid}
      >
        <div className={`${styles.surface} ${styles.surfacePad}`}>
          <div
            hidden={ordinaryActive}
            style={{ display: ordinaryActive ? 'none' : undefined }}
            className={styles.sectionHead}
          >
            <div>
              <h2>Your learning</h2>
              <p className={styles.smallPrint}>
                Recognition first, with a calm next step.
              </p>
            </div>
            <PilotCompanion width={96} height={107} />
          </div>
          <nav
            aria-label="Learning source"
            hidden={ordinaryActive}
            className={`${storyStyles.family} ${storyStyles.actions}`}
          >
            {(
              [
                ['corpus', 'Your stories'],
                ['collection', 'Learning path'],
                ['story', 'Forest story'],
                ['legacy', 'Six-character lesson'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                data-control={`child-source-${value}`}
                aria-pressed={source === value}
                onClick={() => {
                  setOrdinaryActive(false);
                  setSource(value);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <div
            hidden={source !== 'corpus'}
            style={{ display: source === 'corpus' ? undefined : 'none' }}
          >
            <FamilyCorpusEntry
              me={me}
              childId={me.user.id}
              active={source === 'corpus'}
              onContextChange={discovered}
              onActiveChange={setOrdinaryActive}
            />
          </div>
          {source === 'collection' && (
            <CollectionHome
              key={`${me.installationId}:${me.user.id}`}
              me={me}
              onActiveChange={setOrdinaryActive}
            />
          )}
          {source === 'story' && (
            <ChildStoryPanel me={me} onActiveChange={setOrdinaryActive} />
          )}
          {source === 'legacy' && <ChildLearningPanel me={me} />}
        </div>
        <div
          hidden={ordinaryActive}
          style={{ display: ordinaryActive ? 'none' : undefined }}
          className={`${styles.surface} ${styles.surfacePad}`}
        >
          <h2>What your record means</h2>
          <p>
            Little Hanzi keeps first responses, optional help, unavailable sound
            and later review as separate evidence. Finishing a task does not
            create a mastery label.
          </p>
          <div className={styles.infoBand}>
            <ShieldCheck size={18} />
            <span>
              Your account can only read and write its own assigned learner
              record.
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}

function ParentHome({
  me,
  onRefresh,
  onSignOut,
}: {
  me: PilotMe;
  onRefresh: () => void;
  onSignOut: () => void;
}) {
  const [selectedChildId, setSelectedChildId] = useState(
    me.children[0]?.id || '',
  );
  const [teacherId, setTeacherId] = useState('');
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMessage, setGrantMessage] = useState('');
  const [grants, setGrants] = useState<PilotGrant[] | null>(me.grants ?? null);
  const selectedChild =
    me.children.find((child) => child.id === selectedChildId) || me.children[0];
  const priority = useMemo(
    () =>
      createCorpusLoadPriority(
        JSON.stringify([me.installationId, me.user.id, selectedChild?.id]),
      ),
    [me.installationId, me.user.id, selectedChild?.id],
  );
  const initialStage = useSyncExternalStore(
    priority.subscribe,
    priority.snapshot,
    priority.snapshot,
  );
  const backgroundReady = !selectedChild || initialStage === 'released';
  useEffect(() => {
    priority.activate();
    const unregister = registerPilotStoryController(() => priority.lock());
    return () => {
      unregister();
      priority.destroy();
    };
  }, [priority]);

  async function grant(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!selectedChild || !teacherId.trim()) return;
    setGrantBusy(true);
    setGrantMessage('');
    try {
      await grantPilotTeacher(selectedChild.id, teacherId.trim());
      setGrants((old) => {
        const current = old ?? [];
        return current.some(
          (item) =>
            item.childId === selectedChild.id &&
            item.teacherId === teacherId.trim(),
        )
          ? current
          : [
              ...current,
              {
                childId: selectedChild.id,
                teacherId: teacherId.trim(),
                childName: selectedChild.name,
              },
            ];
      });
      setTeacherId('');
      setGrantMessage('Teacher access granted for this child.');
    } catch (grantError) {
      setGrantMessage(messageFor(grantError));
    } finally {
      setGrantBusy(false);
    }
  }

  async function revoke(grant: PilotGrant) {
    setGrantBusy(true);
    setGrantMessage('');
    try {
      await revokePilotTeacher(grant.childId, grant.teacherId);
      setGrants((old) =>
        (old ?? []).filter(
          (item) =>
            !(
              item.childId === grant.childId &&
              item.teacherId === grant.teacherId
            ),
        ),
      );
      setGrantMessage('Teacher access revoked.');
    } catch (revokeError) {
      setGrantMessage(messageFor(revokeError));
    } finally {
      setGrantBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <HomeHeader
        me={me}
        title="A clear next step for each child."
        description="See only the children linked to your account, record what is ready, and choose whether a teacher may read a child’s progress."
      />
      <label className={styles.field}>
        Child for story curriculum
        <select
          data-control="parent-corpus-child"
          value={selectedChild?.id ?? ''}
          onChange={(e) => setSelectedChildId(e.target.value)}
        >
          {me.children.length ? (
            me.children.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))
          ) : (
            <option value="">No linked child</option>
          )}
        </select>
      </label>
      {selectedChild && (
        <FamilyCorpusEntry
          key={selectedChild.id}
          me={me}
          childId={selectedChild.id}
          backgroundReady={backgroundReady}
          onInitialEntry={priority.entry}
          onInitialCatalog={priority.catalog}
        />
      )}
      <CorpusOwnerEntry me={me} />
      <ParentStoryPlan me={me} onSignOut={onSignOut} />
      <ParentCollectionPlan
        key={`${me.installationId}:${me.user.id}`}
        me={me}
        onSignOut={onSignOut}
      />
      {backgroundReady ? (
        <CollectionProgressPanel
          key={`${me.installationId}:${me.user.id}`}
          me={me}
        />
      ) : (
        <section aria-busy="true" data-role="collection-progress-pending">
          <h2>Saved collection learning</h2>
          <output>Loading the lesson choices before saved learning…</output>
        </section>
      )}
      {backgroundReady ? (
        <ParentStoryProgress me={me} />
      ) : (
        <section aria-busy="true" data-role="story-progress-pending">
          <h2>Saved story learning</h2>
          <output>Loading the lesson choices before saved learning…</output>
        </section>
      )}
      <div data-pilot-legacy-layout>
        {backgroundReady ? (
          <ParentLearningPanel me={me} />
        ) : (
          <section aria-busy="true" data-role="legacy-progress-pending">
            <h2>Family progress</h2>
            <output>Loading the lesson choices before saved learning…</output>
          </section>
        )}
      </div>
      <section className={styles.grid} data-pilot-legacy-layout>
        <div className={`${styles.surface} ${styles.surfacePad}`}>
          <div className={styles.sectionHead}>
            <div>
              <h2>Your children</h2>
              <p className={styles.smallPrint}>
                Linked learners stay inside this family boundary.
              </p>
            </div>
            <Users size={22} color="var(--cs-blue)" />
          </div>
          {me.children.length ? (
            <div className={styles.childList}>
              {me.children.map((child) => (
                <button
                  key={child.id}
                  className={styles.childCard}
                  data-selected={selectedChild?.id === child.id}
                  onClick={() => setSelectedChildId(child.id)}
                >
                  <span className={styles.childGlyph}>
                    {child.name.slice(0, 1)}
                  </span>
                  <span className={styles.childCopy}>
                    <strong>{child.name}</strong>
                    <span>
                      {child.assignment?.status === 'assigned'
                        ? 'Lesson assigned'
                        : 'Assignment pending'}
                    </span>
                  </span>
                  <ChevronRight className={styles.childAction} size={18} />
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>
              <div>
                <Users size={27} color="var(--cs-blue)" />
                <h3>No linked children yet</h3>
                <p>
                  An operator will link a child account before learning records
                  appear here.
                </p>
              </div>
            </div>
          )}
        </div>
        <div className={`${styles.surface} ${styles.surfacePad}`}>
          <div className={styles.sectionHead}>
            <div>
              <h2>Starting plan</h2>
              <p className={styles.smallPrint}>
                {selectedChild ? `For ${selectedChild.name}` : 'Choose a child'}
              </p>
            </div>
            <ClipboardList size={22} color="var(--cs-teal)" />
          </div>
          <div className={styles.task}>
            <div className={styles.taskHeader}>
              <strong>Forest lesson assignment</strong>
              <span
                className={styles.status}
                data-state={
                  selectedChild?.assignment?.status === 'assigned'
                    ? 'ready'
                    : 'pending'
                }
              >
                {selectedChild?.assignment?.status === 'assigned'
                  ? 'Ready'
                  : 'Pending'}
              </span>
            </div>
            <p>
              {selectedChild?.assignment?.status === 'assigned'
                ? 'The reviewed lesson is assigned to this child. The lesson connection will use the child-owned route.'
                : 'A parent-approved starting plan will appear here when the child record and lesson assignment are connected.'}
            </p>
            <div className={styles.infoBand}>
              <AlertCircle size={18} />
              <span>
                Completion and task results are evidence about this activity,
                not an unattended-learning or mastery claim.
              </span>
            </div>
          </div>
        </div>
      </section>
      <section
        className={`${styles.surface} ${styles.surfacePad}`}
        data-pilot-legacy-layout
      >
        <div className={styles.sectionHead}>
          <div>
            <h2>Teacher access</h2>
            <p>
              Grant a teacher read-only access to one linked child. The teacher
              ID comes from the pilot operator.
            </p>
          </div>
          <Link2 size={22} color="var(--cs-blue)" />
        </div>
        <form
          className={styles.formActions}
          onSubmit={(event) => void grant(event)}
        >
          <label className={styles.field} style={{ flex: '1 1 260px' }}>
            <span className={styles.fieldLabel}>Teacher ID</span>
            <input
              className={styles.input}
              value={teacherId}
              onChange={(event) => setTeacherId(event.target.value)}
              placeholder="Paste the invited teacher ID"
            />
          </label>
          <label className={styles.field} style={{ flex: '1 1 220px' }}>
            <span className={styles.fieldLabel}>Child</span>
            <select
              className={styles.select}
              value={selectedChild?.id || ''}
              onChange={(event) => setSelectedChildId(event.target.value)}
              disabled={!me.children.length}
            >
              {me.children.length ? (
                me.children.map((child) => (
                  <option key={child.id} value={child.id}>
                    {child.name}
                  </option>
                ))
              ) : (
                <option value="">No linked child</option>
              )}
            </select>
          </label>
          <button
            className={styles.primaryButton}
            type="submit"
            disabled={grantBusy || !teacherId.trim() || !selectedChild}
          >
            {grantBusy ? 'Saving…' : 'Grant read access'}{' '}
            <ArrowRight size={16} />
          </button>
        </form>
        {grantMessage && (
          <output className={styles.smallPrint}>{grantMessage}</output>
        )}
        {grants === null ? (
          <p className={styles.smallPrint}>
            Teacher access could not be loaded. Refresh to try again.
          </p>
        ) : grants.length ? (
          <div className={styles.childList}>
            {grants.map((grantItem) => (
              <div
                className={styles.childCard}
                key={`${grantItem.childId}-${grantItem.teacherId}`}
              >
                <span className={styles.childGlyph}>
                  <Link2 size={20} />
                </span>
                <span className={styles.childCopy}>
                  <strong>
                    {grantItem.teacherName ||
                      `Teacher ${displayUsername(grantItem.teacherId)}`}
                  </strong>
                  <span>
                    {grantItem.childName ||
                      me.children.find(
                        (child) => child.id === grantItem.childId,
                      )?.name ||
                      'Linked child'}{' '}
                    ·{' '}
                    {grantItem.childDisabled
                      ? 'child account disabled'
                      : grantItem.teacherDisabled
                        ? 'teacher account disabled'
                        : 'read-only'}
                  </span>
                </span>
                <button
                  className={styles.dangerButton}
                  onClick={() => void revoke(grantItem)}
                  disabled={grantBusy}
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className={styles.smallPrint}>
            No teacher grants are active for this account.
          </p>
        )}
      </section>
      <section className={`${styles.surface} ${styles.surfacePad}`}>
        <h2>Parent guidance</h2>
        <p>
          Onboarding will ask about a child’s nickname, broad Chinese-learning
          experience and audio readiness. It will not ask for unnecessary
          identifiers or infer mastery from a completed task.
        </p>
        <button className={styles.quietButton} onClick={onRefresh}>
          <RefreshCw size={15} /> Refresh linked records
        </button>
      </section>
    </main>
  );
}

function TeacherHome({ me }: { me: PilotMe }) {
  const [selectedChildId, setSelectedChildId] = useState(
    me.children[0]?.id ?? '',
  );
  const selectedChild = me.children.find((c) => c.id === selectedChildId);
  return (
    <main className={styles.page}>
      <HomeHeader
        me={me}
        title="Learners shared with you."
        description="This view is read-only. A parent’s explicit grant decides which learner records appear."
      />
      <label className={styles.field}>
        Learner for story curriculum
        <select
          data-control="teacher-corpus-child"
          value={selectedChildId}
          onChange={(e) => setSelectedChildId(e.target.value)}
        >
          {me.children.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {selectedChild && (
        <FamilyCorpusEntry
          key={selectedChild.id}
          me={me}
          childId={selectedChild.id}
        />
      )}
      <ParentStoryProgress me={me} readOnly />
      <CollectionProgressPanel
        key={`${me.installationId}:${me.user.id}`}
        me={me}
        readOnly
      />
      <TeacherLearningPanel me={me} />
      <section className={`${styles.surface} ${styles.surfacePad}`}>
        {me.children.length ? (
          <div className={styles.childList}>
            {me.children.map((child) => (
              <div className={styles.childCard} key={child.id}>
                <span className={styles.childGlyph}>
                  {child.name.slice(0, 1)}
                </span>
                <span className={styles.childCopy}>
                  <strong>{child.name}</strong>
                  <span>
                    {child.assignment?.status === 'assigned'
                      ? 'Assigned lesson · evidence will appear here'
                      : 'Assignment pending'}
                  </span>
                </span>
                <span className={styles.status} data-state="active">
                  Read only
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <div>
              <Users size={28} color="var(--cs-blue)" />
              <h2>No learners shared yet</h2>
              <p>
                A parent must grant access before a learner record appears. A
                stale or guessed child ID cannot open another family’s data.
              </p>
            </div>
          </div>
        )}
      </section>
      <div className={styles.infoBand}>
        <ShieldCheck size={18} />
        <span>
          Teaching notes and learner changes are deferred to a later sprint.
          Your account can read only explicitly granted children.
        </span>
      </div>
    </main>
  );
}

function OperatorHome({
  me,
  onRefresh,
}: {
  me: PilotMe;
  onRefresh: () => void;
}) {
  const [opsTab, setOpsTab] = useState<
    'accounts' | 'operations' | 'feedback' | 'observations'
  >('accounts');
  const [accounts, setAccounts] = useState<PilotAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [newAccount, setNewAccount] = useState({
    username: '',
    name: '',
    password: '',
    role: 'parent' as PilotRole,
  });
  const [resetId, setResetId] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [linkParentId, setLinkParentId] = useState('');
  const [linkChildId, setLinkChildId] = useState('');

  async function loadAccounts() {
    setLoading(true);
    setError('');
    try {
      setAccounts(await listPilotAccounts());
    } catch (loadError) {
      setError(messageFor(loadError));
    } finally {
      setLoading(false);
    }
  }

  // oxlint-disable react/react-compiler -- Account metadata is an external pilot read.
  useEffect(() => {
    void loadAccounts();
  }, []);
  // oxlint-enable react/react-compiler

  const parents = useMemo(
    () => accounts.filter((account) => account.role === 'parent'),
    [accounts],
  );
  const children = useMemo(
    () => accounts.filter((account) => account.role === 'child'),
    [accounts],
  );
  const inactiveLinkTarget = Boolean(
    parents.find((account) => account.id === linkParentId)?.disabled ||
    children.find((account) => account.id === linkChildId)?.disabled,
  );

  async function issue(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (
      !newAccount.username.trim() ||
      !newAccount.name.trim() ||
      newAccount.password.length < 8
    ) {
      setError(
        'Enter a username, name and password with at least 8 characters.',
      );
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await createPilotAccount({
        ...newAccount,
        username: newAccount.username.trim(),
        name: newAccount.name.trim(),
      });
      setNewAccount({ username: '', name: '', password: '', role: 'parent' });
      setMessage(
        'Account issued. Share the username and one-time password through your private operator process.',
      );
      await loadAccounts();
    } catch (issueError) {
      setError(messageFor(issueError));
    } finally {
      setBusy(false);
    }
  }

  async function reset(account: PilotAccount) {
    if (resetPassword.length < 8) {
      setError('Enter a reset password with at least 8 characters.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await resetPilotAccount(account.id, resetPassword);
      setResetId('');
      setResetPassword('');
      setMessage(`${account.name} must choose a new password at next sign-in.`);
      await loadAccounts();
    } catch (resetError) {
      setError(messageFor(resetError));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(account: PilotAccount) {
    setBusy(true);
    setError('');
    try {
      await setPilotAccountStatus(account.id, !account.disabled);
      setMessage(
        account.disabled
          ? `${account.name} is enabled.`
          : `${account.name} is disabled and signed out.`,
      );
      await loadAccounts();
    } catch (statusError) {
      setError(messageFor(statusError));
    } finally {
      setBusy(false);
    }
  }

  async function link(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (!linkParentId || !linkChildId) return;
    if (inactiveLinkTarget) {
      setError(
        'Inactive accounts can have links removed, but cannot receive new links.',
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      await linkPilotChild(linkParentId, linkChildId);
      setMessage('Parent-child link saved.');
      setLinkParentId('');
      setLinkChildId('');
    } catch (linkError) {
      setError(messageFor(linkError));
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!linkParentId || !linkChildId) return;
    setBusy(true);
    setError('');
    try {
      await unlinkPilotChild(linkParentId, linkChildId);
      setMessage('The exact parent-child link was removed.');
      setLinkParentId('');
      setLinkChildId('');
    } catch (unlinkError) {
      setError(messageFor(unlinkError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={`${styles.page} ${opsStyles.operatorPage}`}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Invited pilot · Operator</p>
          <h1>
            {opsTab === 'accounts'
              ? 'Account access desk.'
              : opsTab === 'operations'
                ? 'Pilot operations.'
                : opsTab === 'feedback'
                  ? 'Feedback desk.'
                  : 'Observation notes.'}
          </h1>
          <p>
            {opsTab === 'accounts'
              ? 'Issue invited accounts and manage exact family links. Passwords and sessions stay on the server.'
              : 'Review current operations and attributed reports. Private details stay in this account view.'}
          </p>
        </div>
        <span className={styles.roleTag}>
          <ShieldCheck size={15} /> Account administration
        </span>
      </header>
      <nav className={opsStyles.tabs} aria-label="Operator tools">
        {(['accounts', 'operations', 'feedback', 'observations'] as const).map(
          (tab) => (
            <button
              key={tab}
              type="button"
              data-ops-tab={tab}
              aria-pressed={opsTab === tab}
              onClick={() => setOpsTab(tab)}
            >
              {tab === 'accounts'
                ? 'Accounts and content'
                : tab === 'operations'
                  ? 'Operations'
                  : tab === 'feedback'
                    ? 'Feedback'
                    : 'Observations'}
            </button>
          ),
        )}
      </nav>
      <div
        className={opsStyles.accountPane}
        hidden={opsTab !== 'accounts'}
        inert={opsTab !== 'accounts' || undefined}
      >
        {error && (
          <PilotAlert text={error} onRetry={() => void loadAccounts()} />
        )}
        {message && (
          <output className={styles.successText}>
            <Check size={16} /> {message}
          </output>
        )}
        <section className={styles.grid}>
          <div className={`${styles.surface} ${styles.surfacePad}`}>
            <div className={styles.sectionHead}>
              <div>
                <h2>Issue an account</h2>
                <p className={styles.smallPrint}>
                  The account must change this password at first sign-in.
                </p>
              </div>
              <UserPlus size={22} color="var(--cs-blue)" />
            </div>
            <form
              className={styles.fieldStack}
              onSubmit={(event) => void issue(event)}
            >
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Username</span>
                <input
                  className={styles.input}
                  value={newAccount.username}
                  onChange={(event) =>
                    setNewAccount((old) => ({
                      ...old,
                      username: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Display name</span>
                <input
                  className={styles.input}
                  value={newAccount.name}
                  onChange={(event) =>
                    setNewAccount((old) => ({
                      ...old,
                      name: event.target.value,
                    }))
                  }
                  autoComplete="off"
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Role</span>
                <select
                  className={styles.select}
                  value={newAccount.role}
                  onChange={(event) =>
                    setNewAccount((old) => ({
                      ...old,
                      role: event.target.value as PilotRole,
                    }))
                  }
                >
                  <option value="child">Child</option>
                  <option value="parent">Parent</option>
                  <option value="teacher">Teacher</option>
                  <option value="operator">Operator</option>
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>One-time password</span>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="new-password"
                  value={newAccount.password}
                  onChange={(event) =>
                    setNewAccount((old) => ({
                      ...old,
                      password: event.target.value,
                    }))
                  }
                />
              </label>
              <p className={styles.formHint}>
                The pilot never displays internal auth email values or session
                tokens.
              </p>
              <div className={styles.formActions}>
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={busy}
                >
                  {busy ? 'Issuing…' : 'Issue account'} <UserPlus size={16} />
                </button>
              </div>
            </form>
          </div>
          <div className={`${styles.surface} ${styles.surfacePad}`}>
            <div className={styles.sectionHead}>
              <div>
                <h2>Link a family</h2>
                <p className={styles.smallPrint}>
                  Choose a parent and child to add or remove their link.
                  Inactive accounts can only have links removed.
                </p>
              </div>
              <Link2 size={22} color="var(--cs-teal)" />
            </div>
            <form
              className={styles.fieldStack}
              onSubmit={(event) => void link(event)}
            >
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Parent</span>
                <select
                  className={styles.select}
                  value={linkParentId}
                  onChange={(event) => setLinkParentId(event.target.value)}
                >
                  <option value="">Choose a parent</option>
                  {parents.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} · {displayUsername(account.username)}
                      {account.disabled ? ' · Inactive' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Child</span>
                <select
                  className={styles.select}
                  value={linkChildId}
                  onChange={(event) => setLinkChildId(event.target.value)}
                >
                  <option value="">Choose a child</option>
                  {children.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} · {displayUsername(account.username)}
                      {account.disabled ? ' · Inactive' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.formActions}>
                <button
                  className={styles.primaryButton}
                  type="submit"
                  disabled={
                    busy || !linkParentId || !linkChildId || inactiveLinkTarget
                  }
                >
                  Save link <Link2 size={16} />
                </button>
                <button
                  className={styles.outlineButton}
                  type="button"
                  onClick={() => void unlink()}
                  disabled={busy || !linkParentId || !linkChildId}
                >
                  Remove exact link
                </button>
              </div>
            </form>
          </div>
        </section>
        <section className={`${styles.surface} ${styles.surfacePad}`}>
          <div className={styles.sectionHead}>
            <div>
              <h2>Issued accounts</h2>
              <p className={styles.smallPrint}>
                Metadata only. No password, internal email or session value is
                returned to this screen.
              </p>
            </div>
            <button
              className={styles.quietButton}
              onClick={() => {
                onRefresh();
                void loadAccounts();
              }}
              disabled={loading}
            >
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
          {loading ? (
            <div className={styles.loading}>
              <p>Loading account metadata…</p>
            </div>
          ) : accounts.length ? (
            <div className={styles.tableWrap}>
              <table className={styles.accountTable}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Username</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((account) => (
                    <tr key={account.id}>
                      <td>
                        <strong>{account.name}</strong>
                        <span className={styles.smallPrint}>
                          {account.mustChangePassword
                            ? 'Password change required'
                            : 'Password set'}
                        </span>
                      </td>
                      <td>{displayUsername(account.username)}</td>
                      <td>{roleLabel(account.role)}</td>
                      <td>
                        <span
                          className={styles.status}
                          data-state={account.disabled ? 'disabled' : 'active'}
                        >
                          {account.disabled ? 'Disabled' : 'Active'}
                        </span>
                      </td>
                      <td>
                        <div className={styles.tableActions}>
                          <button
                            className={styles.outlineButton}
                            onClick={() => {
                              setResetId(
                                resetId === account.id ? '' : account.id,
                              );
                              setResetPassword('');
                            }}
                            disabled={busy}
                          >
                            <KeyRound size={14} /> Reset
                          </button>
                          <button
                            className={
                              account.disabled
                                ? styles.outlineButton
                                : styles.dangerButton
                            }
                            onClick={() => void toggleStatus(account)}
                            disabled={busy}
                          >
                            {account.disabled ? 'Enable' : 'Disable'}
                          </button>
                        </div>
                        {resetId === account.id && (
                          <div className={styles.formActions}>
                            <input
                              className={styles.input}
                              type="password"
                              placeholder="New one-time password"
                              value={resetPassword}
                              onChange={(event) =>
                                setResetPassword(event.target.value)
                              }
                              autoComplete="new-password"
                            />
                            <button
                              className={styles.primaryButton}
                              onClick={() => void reset(account)}
                              disabled={busy || resetPassword.length < 8}
                            >
                              Save reset
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className={styles.empty}>
              <div>
                <Users size={28} color="var(--cs-blue)" />
                <h3>No accounts issued</h3>
                <p>Issue the first invited account above.</p>
              </div>
            </div>
          )}
        </section>
        <OperatorCorpusPanel me={me} />
        <CorpusOwnerEntry me={me} />
        <CollectionRegisterPanel
          key={`${me.installationId}:${me.user.id}`}
          me={me}
        />
        <OperatorReviewDesk me={me} onRefresh={onRefresh} />
        <section className={styles.infoBand}>
          <LockKeyhole size={18} />
          <span>
            Disabling or resetting an account revokes its sessions. This desk
            cannot impersonate a learner.
          </span>
        </section>
      </div>
      <OperatorOpsPanel
        key={`${me.installationId}:${me.user.id}`}
        me={me}
        view={opsTab === 'accounts' ? 'operations' : opsTab}
        active={opsTab !== 'accounts'}
      />
    </main>
  );
}
