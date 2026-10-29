/**
 * The team configuration block inside the board's own settings card.
 *
 * It renders what the Host published (hub URL, team id, hostname, whether a Host
 * Token is configured, the live connection state and which optional board
 * capabilities this deployment really serves) and it writes through the board's
 * same-origin action channel, which is the only channel a provider has. A token
 * value travels exactly once, from this input to the Host, and is never read
 * back: the field always renders empty and the status line says whether one is
 * stored.
 *
 * The block stays reachable while the extension is switched off, because it is
 * where the switch is turned back on; it only reports that fact instead of
 * pretending the forms still apply.
 *
 * @module dsh-task-board-team/client/team/settings
 */
import { useState, type ReactElement } from 'react'
import type { TaskBoardExtensionDispatch, TaskBoardSettingsSectionProps } from '../../core/contract.ts'
import { TEAM_EXTENSION_ID } from '../../core/identity.ts'
import type { TeamExtensionSummary } from '../../host/service.ts'
import { t, type TeamKey } from '../locales.ts'
import { useTeamSummary } from './summary.ts'
import styles from './team.module.css'

/** What the published summary carries about the configuration itself. */
interface PublishedConfiguration {
  hubUrl?: string
  teamId?: string
  hostname?: string
  tokenConfigured?: boolean
}

/**
 * Read the configuration half of one summary.
 * @param summary - the published summary, or undefined.
 * @returns the configuration fields the card renders.
 */
export function readConfiguration(summary: TeamExtensionSummary | undefined): PublishedConfiguration {
  const configuration = summary?.configuration
  if (configuration === undefined) return {}
  return {
    ...(configuration.hubUrl === undefined ? {} : { hubUrl: configuration.hubUrl }),
    ...(configuration.teamId === undefined ? {} : { teamId: configuration.teamId }),
    ...(configuration.hostname === undefined ? {} : { hostname: configuration.hostname }),
    ...(configuration.tokenConfigured === undefined ? {} : { tokenConfigured: configuration.tokenConfigured }),
  }
}

/**
 * Dispatch one action of this extension.
 * @param dispatch - the board's action dispatcher.
 * @param action - provider-owned action name.
 * @param payload - opaque payload.
 * @returns whether the board accepted the action.
 */
async function send(
  dispatch: TaskBoardExtensionDispatch,
  action: string,
  payload?: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await dispatch({
      extensionId: TEAM_EXTENSION_ID,
      action,
      ...(payload === undefined ? {} : { payload }),
    })
  } catch {
    return false
  }
}

/** One capability line of the settings block. */
function Capability({ label, available, missing }: { label: string; available: boolean; missing: string }): ReactElement {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>
        {available ? t('section.capability.available') : t('section.capability.missing') + ' — ' + missing}
      </span>
    </div>
  )
}

/**
 * The settings block.
 * @param props - the board's settings seat props.
 * @returns the block.
 */
export function TeamSettingsSection({ dispatch }: TaskBoardSettingsSectionProps): ReactElement {
  const summary = useTeamSummary()
  const configuration = readConfiguration(summary)
  const [hubUrl, setHubUrl] = useState<string | undefined>(undefined)
  const [teamId, setTeamId] = useState<string | undefined>(undefined)
  const [members, setMembers] = useState<string | undefined>(undefined)
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)

  const connection = summary?.connection.state ?? 'idle'
  const membersValue = members ?? (summary?.agents ?? []).map(agent => agent.memberId).join(', ')
  const stateKey = ('section.connection.' + connection) as TeamKey

  const saveSettings = async (): Promise<void> => {
    const bindings = (membersValue ?? '')
      .split(',')
      .map(entry => entry.trim())
      .filter(entry => entry !== '')
      .map(memberId => ({ memberId }))
    const ok = await send(dispatch, 'setup-save', {
      ...(hubUrl === undefined ? {} : { hubUrl }),
      ...(teamId === undefined ? {} : { teamId }),
      agents: bindings,
    })
    setSaved(ok)
  }

  return (
    <div className={styles.section} data-dsh-plugin="task-board-team" data-dsh-part="team-settings">
      <p className={styles.title}>{t('section.title')}</p>
      <div className={styles.row}>
        <span className={styles.label}>{t('section.connection')}</span>
        <span className={styles.value} data-dsh-part="team-connection">{t(stateKey)}</span>
      </div>
      {summary?.connection.hostId === undefined ? null : (
        <div className={styles.row}>
          <span className={styles.label}>{t('section.host')}</span>
          <span className={styles.value}>{summary.connection.hostId}</span>
        </div>
      )}
      <label className={styles.row}>
        <span className={styles.label}>{t('section.hub')}</span>
        <input
          className={styles.input}
          value={hubUrl ?? configuration.hubUrl ?? ''}
          placeholder="https://hub.example.com"
          onChange={event => { setHubUrl(event.target.value) }}
        />
      </label>
      <label className={styles.row}>
        <span className={styles.label}>{t('section.team')}</span>
        <input
          className={styles.input}
          value={teamId ?? configuration.teamId ?? ''}
          placeholder="team_..."
          onChange={event => { setTeamId(event.target.value) }}
        />
      </label>
      <label className={styles.row}>
        <span className={styles.label}>{t('section.token')}</span>
        <span className={styles.value}>
          {configuration.tokenConfigured === true ? t('section.token.configured') : t('section.token.missing')}
        </span>
      </label>
      <input
        className={styles.input}
        type="password"
        placeholder={t('section.token.placeholder')}
        value={token}
        onChange={event => { setToken(event.target.value) }}
      />
      <label className={styles.row}>
        <span className={styles.label}>{t('section.agents')}</span>
        <input
          className={styles.input}
          value={membersValue}
          placeholder="member_..."
          onChange={event => { setMembers(event.target.value) }}
        />
      </label>
      <p className={styles.meta}>{t('section.agents.hint')}</p>
      {(summary?.agents ?? []).length === 0 ? <p className={styles.empty}>{t('section.agents.empty')}</p> : null}
      <div className={styles.actions}>
        <button className={styles.button} type="button" onClick={() => { void saveSettings() }}>{t('section.save')}</button>
        <button
          className={styles.button}
          type="button"
          disabled={token.trim() === ''}
          onClick={() => {
            void send(dispatch, 'set-token', { token }).then(ok => {
              if (ok) { setToken(''); setSaved(true) } else setSaved(false)
            })
          }}
        >
          {t('section.token.save')}
        </button>
        <button className={styles.button} type="button" onClick={() => { void send(dispatch, 'clear-token') }}>{t('section.token.clear')}</button>
        <button className={styles.button} type="button" onClick={() => { void send(dispatch, 'refresh') }}>{t('section.refresh')}</button>
      </div>
      {saved ? <p className={styles.meta}>{t('section.saved')}</p> : null}
      <div>
        <p className={styles.title}>{t('section.capabilities')}</p>
        <Capability
          label={t('section.capability.followUp')}
          available={summary?.capabilities.followUp === true}
          missing={t('section.capability.followUpMissing')}
        />
        <Capability
          label={t('section.capability.rework')}
          available={summary?.capabilities.rework === true}
          missing={t('section.capability.reworkMissing')}
        />
        <Capability
          label={t('section.capability.run')}
          available={summary?.capabilities.run === true}
          missing={t('section.capability.runMissing')}
        />
      </div>
      {(summary?.problems ?? []).length === 0 ? null : (
        <div>
          <p className={styles.title}>{t('section.problems')}</p>
          <ul className={styles.list}>
            {(summary?.problems ?? []).map(problem => (
              <li key={problem} className={styles.entry}><span className={styles.body}>{problem}</span></li>
            ))}
          </ul>
        </div>
      )}
      {summary?.connection.lastError === undefined ? null : (
        <p className={styles.error}>{summary.connection.lastError}</p>
      )}
    </div>
  )
}