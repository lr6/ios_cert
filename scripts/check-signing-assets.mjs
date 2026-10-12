#!/usr/bin/env node
/**
 * iOS 签名材料自检（本地、离线）。
 *
 * 用途：HBuilderX / uni-app 云打包报 "certificate file(p12) import failed" 之类错误时，
 * 先用它把「证书(p12) + 描述文件(mobileprovision)」这对文件本身检查清楚：
 *   - p12 里到底有没有私钥？密码对不对？
 *   - 证书是开发证书还是发布/企业证书？过期了吗？TeamID 是多少？
 *   - 描述文件里是否包含这张证书？（不匹配是最常见的失败原因）
 *   - 描述文件是开发/AdHoc/企业/AppStore 哪一种？
 *
 * 用法：
 *   node scripts/check-signing-assets.mjs <证书.p12> <描述文件.mobileprovision> [p12密码]
 *   node scripts/check-signing-assets.mjs <证书.p12> [p12密码]        # 只检查 p12
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import forge from 'node-forge'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('用法: node scripts/check-signing-assets.mjs <证书.p12> [描述文件.mobileprovision] [p12密码]')
  process.exit(2)
}

const p12Path = args[0]
const isProfile = args[1] && /\.mobileprovision$/i.test(args[1])
const profilePath = isProfile ? args[1] : null
const password = (isProfile ? args[2] : args[1]) ?? ''

const problems = []
const notes = []

function line(text) {
  console.log(text)
}

line('='.repeat(72))
line('iOS 签名材料自检')
line('='.repeat(72))

// ---------- 1. p12 ----------
line('')
line(`[1] 证书文件: ${basename(p12Path)}`)

let p12 = null
try {
  const bytes = readFileSync(p12Path)
  p12 = parseP12(bytes, password)
  line(`    密码: ${password ? '已提供（能打开）' : '空密码（能打开）'}`)
} catch (error) {
  const reason = describeP12Error(error)
  problems.push(`p12 无法打开：${reason}`)
  line(`    ✗ 无法打开：${reason}`)
}

if (p12) {
  if (p12.privateKey) {
    line(`    私钥: ✓ 存在（${p12.privateKeyBits} 位 RSA${p12.privateKeyType === 'EC' ? '（EC）' : ''}）`)
  } else {
    problems.push('p12 中没有任何私钥 —— 云打包必须用「含私钥」的 p12（导出时要同时选中证书与私钥）')
    line('    私钥: ✗ 不存在')
  }

  line(`    证书数量: ${p12.certificates.length}`)
  const leaf = p12.certificates[0]
  if (leaf) {
    line(`    证书 Subject: ${leaf.subject}`)
    line(`    证书 Issuer : ${leaf.issuer}`)
    line(`    有效期: ${leaf.notBefore.toISOString().slice(0, 10)} ~ ${leaf.notAfter.toISOString().slice(0, 10)}`)
    line(`    序列号: ${leaf.serialNumber}`)

    const kind = classifyCertificate(leaf.subject)
    line(`    证书类型: ${kind.label}`)
    if (kind.isDevelopment) {
      notes.push('这是“开发证书”。若你要打发布包（App Store / 企业分发），必须换成 Apple Distribution 或企业证书')
    }
    if (kind.teamId) line(`    TeamID: ${kind.teamId}`)

    const now = Date.now()
    if (leaf.notAfter.getTime() < now) {
      problems.push(`证书已于 ${leaf.notAfter.toISOString().slice(0, 10)} 过期`)
      line('    ✗ 证书已过期')
    } else if (leaf.notBefore.getTime() > now) {
      problems.push('证书尚未生效')
      line('    ✗ 证书尚未生效')
    }
    const daysLeft = Math.ceil((leaf.notAfter.getTime() - now) / 86400000)
    line(`    距离过期: ${daysLeft} 天`)

    if (p12.certificates.length === 1) {
      notes.push(
        'p12 中只有叶子证书，没有中间证书（Apple WWDR）。多数云打包不需要，但如果对方校验证书链，需要把 Apple WWDR 中间证书一并打包'
      )
    }
  }
}

// ---------- 2. mobileprovision ----------
if (profilePath) {
  line('')
  line(`[2] 描述文件: ${basename(profilePath)}`)
  try {
    const profile = parseMobileProvision(readFileSync(profilePath))
    line(`    名称: ${profile.name}`)
    line(`    UUID: ${profile.uuid}`)
    line(`    App ID: ${profile.appId ?? '—'}`)
    line(`    类型: ${profile.kind}`)
    line(`    过期时间: ${profile.expiration ?? '—'}`)
    line(`    TeamID: ${(profile.teamIds ?? []).join(', ') || '—'}`)
    line(`    内含证书数量: ${profile.certificateDerList.length}`)

    if (profile.expiration && new Date(profile.expiration).getTime() < Date.now()) {
      problems.push(`描述文件已过期（${profile.expiration}）`)
      line('    ✗ 描述文件已过期')
    }
    if (profile.kind === '开发（Development）') {
      notes.push('描述文件是开发类型（含 ProvisionedDevices）：只能用于开发调试，不能用于发布')
    }
    if (profile.getTaskAllow && profile.kind.includes('Development')) {
      notes.push('描述文件包含 get-task-allow=true（调试权限），上架发布包不能带这个权限')
    }

    // ---------- 3. 匹配性 ----------
    line('')
    line('[3] 证书与描述文件是否匹配')
    const profileCerts = profile.certificateDerList.map((der) => bytesToHex(der))
    const p12Certs = p12 ? p12.certificates.map((cert) => bytesToHex(cert.der)) : []
    const matchedIndex = p12Certs.findIndex((hex) => profileCerts.includes(hex))

    if (!p12) {
      line('    - 跳过（p12 无法解析）')
    } else if (matchedIndex >= 0) {
      line(`    ✓ 匹配：描述文件中包含该 p12 里的第 ${matchedIndex + 1} 张证书`)
    } else {
      problems.push('证书与描述文件不匹配：描述文件的 DeveloperCertificates 里没有这张证书')
      line('    ✗ 不匹配：描述文件里没有这张证书')
    }

    if (p12 && p12.certificates[0] && profile.teamIds?.length) {
      const certTeam = classifyCertificate(p12.certificates[0].subject).teamId
      if (certTeam && !profile.teamIds.includes(certTeam)) {
        problems.push(`TeamID 不一致：证书属于 ${certTeam}，描述文件属于 ${profile.teamIds.join(', ')}`)
        line(`    ✗ TeamID 不一致（证书 ${certTeam} / 描述文件 ${profile.teamIds.join(', ')}）`)
      } else if (certTeam) {
        line(`    ✓ TeamID 一致（${certTeam}）`)
      }
    }
  } catch (error) {
    problems.push(`描述文件无法解析：${error.message}`)
    line(`    ✗ 无法解析：${error.message}`)
  }
}

// ---------- 结论 ----------
line('')
line('='.repeat(72))
if (problems.length === 0) {
  line('结论：没有发现明显问题。若云打包仍报“证书导入失败”，请优先检查：')
  line('  1) 在云打包界面填写的 p12 密码是否与导出时完全一致（注意全角/半角、首尾空格）')
  line('  2) 上传的 p12 是否就是刚才检查的这一个文件（避免选错文件）')
  line('  3) 打包类型（开发/发布）与证书类型是否一致')
} else {
  line('发现的问题：')
  for (const [index, problem] of problems.entries()) line(`  ${index + 1}. ${problem}`)
}
if (notes.length > 0) {
  line('')
  line('提示：')
  for (const note of notes) line(`  - ${note}`)
}
line('='.repeat(72))

process.exit(problems.length > 0 ? 1 : 0)

// --------------------------------------------------------------------------

function describeP12Error(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/MAC could not be verified|invalid password/i.test(message)) {
    return '密码错误或文件已损坏（请确认导出时设置的 p12 密码，注意全角/半角与首尾空格）'
  }
  if (/unsupported MAC algorithm/i.test(message)) return `不支持的 MAC 算法：${message}`
  if (/not a PKCS#12|PFX/i.test(message)) return `不是有效的 PKCS#12 文件：${message}`
  return message
}

function parseP12(bytes, pass) {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(binaryStringFromBytes(bytes)))
  const pfx = forge.pkcs12.pkcs12FromAsn1(asn1, pass)

  const shrouded =
    pfx.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []
  const plain = pfx.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []
  const keyBag = shrouded[0] ?? plain[0]

  const certBags = pfx.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []
  const certificates = certBags
    .map((bag) => bag.cert)
    .filter(Boolean)
    .map((cert) => ({
      der: binaryStringFromBytesToUint8(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()),
      subject: formatDn(cert.subject),
      issuer: formatDn(cert.issuer),
      notBefore: cert.validity.notBefore,
      notAfter: cert.validity.notAfter,
      serialNumber: (cert.serialNumber ?? '').replace(/^0+/, '').toUpperCase()
    }))

  const key = keyBag?.key
  return {
    privateKey: key ?? null,
    privateKeyBits: key?.n ? key.n.bitLength() : 0,
    privateKeyType: key?.n ? 'RSA' : 'EC',
    certificates
  }
}

function parseMobileProvision(bytes) {
  const text = Buffer.from(bytes).toString('latin1')
  const start = text.indexOf('<?xml')
  const end = text.indexOf('</plist>')
  if (start < 0 || end < 0) {
    throw new Error('未找到内嵌的 plist（文件可能不是 .mobileprovision，或已损坏）')
  }
  const xml = text.slice(start, end + '</plist>'.length)

  const string = (key) => {
    const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)
    return match ? match[1] : null
  }
  const date = (key) => {
    const match = new RegExp(`<key>${key}</key>\\s*<date>([^<]*)</date>`).exec(xml)
    return match ? match[1] : null
  }
  const arrayFirstStrings = (key) => {
    const block = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml)
    if (!block) return []
    return [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
  }
  const dataList = (key) => {
    const block = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml)
    if (!block) return []
    return [...block[1].matchAll(/<data>([\s\S]*?)<\/data>/g)].map((m) => base64ToBytes(m[1].replace(/\s+/g, '')))
  }

  const hasProvisionedDevices = /<key>ProvisionedDevices<\/key>/.test(xml)
  const provisionsAllDevices = /<key>ProvisionsAllDevices<\/key>/.test(xml)
  const getTaskAllow = /<key>get-task-allow<\/key>\s*<true\/>/.test(xml)

  let kind = 'App Store / 发布'
  if (provisionsAllDevices) kind = '企业分发（In-House）'
  else if (hasProvisionedDevices && getTaskAllow) kind = '开发（Development）'
  else if (hasProvisionedDevices) kind = 'Ad Hoc'

  return {
    name: string('Name') ?? '—',
    uuid: string('UUID') ?? '—',
    appId: string('application-identifier'),
    teamIds: arrayFirstStrings('TeamIdentifier'),
    expiration: date('ExpirationDate'),
    kind,
    getTaskAllow,
    certificateDerList: dataList('DeveloperCertificates')
  }
}

function classifyCertificate(subject) {
  const teamId = /\(([A-Z0-9]{10})\)/.exec(subject)?.[1] ?? null
  if (/Apple Development/i.test(subject)) return { label: 'Apple Development（开发证书）', isDevelopment: true, teamId }
  if (/Apple Distribution/i.test(subject))
    return { label: 'Apple Distribution（发布证书）', isDevelopment: false, teamId }
  if (/iPhone Developer/i.test(subject))
    return { label: 'iPhone Developer（旧版开发证书）', isDevelopment: true, teamId }
  if (/iPhone Distribution|iPhone 分发/i.test(subject))
    return { label: 'iPhone Distribution（发布/企业证书）', isDevelopment: false, teamId }
  if (/Developer ID/i.test(subject))
    return { label: 'Developer ID（用于 macOS 分发，不用于 iOS 云打包）', isDevelopment: false, teamId }
  return { label: '未知类型（请核对是否为 Apple 签发的 iOS 证书）', isDevelopment: false, teamId }
}

function formatDn(distinguishedName) {
  return distinguishedName.attributes
    .map((attribute) => `${attribute.shortName ?? attribute.name}=${attribute.value}`)
    .join(', ')
}

function base64ToBytes(base64) {
  const binary = Buffer.from(base64, 'base64')
  return new Uint8Array(binary)
}

function binaryStringFromBytes(bytes) {
  return Buffer.from(bytes).toString('latin1')
}

function binaryStringFromBytesToUint8(binary) {
  return new Uint8Array(Buffer.from(binary, 'latin1'))
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString('hex')
}
