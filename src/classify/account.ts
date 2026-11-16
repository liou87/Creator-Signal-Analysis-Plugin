import type { AccountFinding, CreatorSnapshot, Tri, VideoItem } from '../types';
import { BUSINESS_CONTACT } from './rules';

/**
 * 账号层信号。每项三态：有 / 无 / 未能检查（D-13）。
 * 入口类（充电、课程）由提取层直接观察；文本类（商务联系方式、店铺、站外付费社群）由简介推出。
 * 每一项都必须对应一种付钱方（D-39），所以只拉关注的公众号、小红书不算（D-40）。
 */

/** 店铺：站内小店或站外网店都算。网页上看不到小店入口，只能看简介里写没写（D-40） */
const SHOP =
  /(淘宝|天猫|京东|拼多多|微店|有赞|抖音|小红书)[^，。\n|｜]{0,6}(店|小店|旗舰店)|(淘宝|天猫|京东|拼多多)[^，。\n|｜]{0,4}搜|(店铺|网店|小店|淘宝店|旗舰店)(名|名称)?\s*[:：]|(同名|自家|我的|个人)[^，。\n|｜]{0,4}(店铺|小店|网店|周边店)|周边(店|小店|店铺)/i;

/** 站外付费社群：粉丝在站外付费 */
const PAID_COMMUNITY = /知识星球|爱发电|afdian|面包多|小报童|patreon|付费(群|社群|会员|专栏|圈子)/i;

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

  const entry = (state: Tri, name: string) =>
    state === 'yes' ? { state, basis: `接口或页面显示已开通${name}` } : { state };

  // 充电没查到时，如果样本里有充电专属视频，那充电一定是开通了的
  let charge: { state: Tri; basis?: string } = entry(snapshot.hasCharge, '充电');
  if (charge.state !== 'yes') {
    const exclusive = videos.find((v) => v.badges?.includes('充电专属'));
    if (exclusive) {
      charge = { state: 'yes', basis: `有充电专属视频：《${exclusive.title}》` };
    }
  }

  // 店铺：页面上看到了小店入口就算有（目前没在网页上见过）；否则看简介
  const shop =
    snapshot.hasShop === 'yes' ? entry('yes', '小店') : fromBio(snapshot.bio, SHOP);

  return [
    { id: 'businessContact', ...business },
    { id: 'shop', ...shop },
    { id: 'course', ...entry(snapshot.hasCourse, '课程') },
    { id: 'paidCommunity', ...fromBio(snapshot.bio, PAID_COMMUNITY) },
    { id: 'charge', ...charge },
  ];
}
