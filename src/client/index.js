/**
 * DSH Web client entry for the EO Assistant settings section.
 * Loaded through package.json exports["./client"] and dsh.client.
 */
import { EoConnectSection } from './section.js'

export const inject = ['slots']

export function apply(ctx) {
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'eo-assistant',
    order: 40,
    label: () => 'EO助手连接',
  }, EoConnectSection)), 'eo: settings section')
}
