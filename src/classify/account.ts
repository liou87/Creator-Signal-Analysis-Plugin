import type { AccountFinding, CreatorSnapshot, Tri, VideoItem } from '../types';
import { BUSINESS_CONTACT } from './rules';

/**
 * 账号层信号。每项三态：有 / 无 / 未能检查（D-13）。
 * 入口类（充电、小店、课程）由提取层直接观察；文本类由简介推出。
 */

const OFFSITE =
  /(淘宝|天猫|京东|拼多多|微店|闲鱼|小红书)[^，。\n]{0,6}(店|搜)|店铺[:：]|公众号|知识星球|爱发电|afdian|面包多|小程序|付费(群|社群)|patreon/i;

const ORG = /MCN|签约(机构|公司|于)?|经纪(公司|合作)|厂牌|旗下(艺人|创作者|账号)|官方账号|有限公司/i;

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const m = pattern.exec(text);
  if (!m) return undefined;
  const start = Math.max(0, m.index - 10);
  return (text.slice(start, m.index + m[0].length + 20).split('\n')[0] ?? '').trim();
}

/** 文本类信号：简介取到了才能说「无」，没取到只能说「未能检查」 */
function fromBio(bio: string | null, pattern: RegExp): { state: Tri; basis?: string } {
  if (bio === null) return { state: 'unknown' };
  const hit = firstMatch(bio, pattern);
  return hit ? { state: 'yes', basis: `简介：「${hit}」` } : { state: 'no' };
}

export function classifyAccount(
  snapshot: CreatorSnapshot,
  videos: VideoItem[],
): AccountFinding[] {
  // 商务联系方式：简介里有，或者在视频简介脚注里反复出现
  let business = fromBio(snapshot.bio, BUSINESS_CONTACT);
  if (business.state !== 'yes') {
    const footers = videos
      .map((v) => (v.desc ? firstMatch(v.desc, BUSINESS_CONTACT) : undefined))
      .filter((x): x is string => Boolean(x));
    if (footers.length >= 2) {
      business = {
        state: 'yes',
        basis: `${footers.length} 条视频简介含商务联系方式：「${footers[0]}」`,
      };
    }
  }

  let org = fromBio(snapshot.bio, ORG);
  if (org.state !== 'yes' && snapshot.officialTitle !== null) {
    const hit = firstMatch(snapshot.officialTitle, /机构|企业|官方|公司|组织|媒体/);
    if (hit) org = { state: 'yes', basis: `认证：「${snapshot.officialTitle}」` };
    else if (org.state === 'unknown') org = { state: 'no' };
  }

  const entry = (state: Tri, name: string) =>
    state === 'yes' ? { state, basis: `接口或页面显示已开通${name}` } : { state };

  return [
    { id: 'businessContact', ...business },
    { id: 'shop', ...entry(snapshot.hasShop, '小店/橱窗') },
    { id: 'course', ...entry(snapshot.hasCourse, '课程') },
    { id: 'offsite', ...fromBio(snapshot.bio, OFFSITE) },
    { id: 'org', ...org },
    { id: 'charge', ...entry(snapshot.hasCharge, '充电') },
  ];
}
