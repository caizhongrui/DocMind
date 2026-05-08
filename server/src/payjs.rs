//! PayJS payment gateway integration.
//!
//! PayJS is an aggregator that exposes Alipay + WeChat Pay through one
//! REST API. Reference: https://payjs.cn/api
//!
//! Two surfaces are used:
//! - Outbound: create an order via `POST https://payjs.cn/api/native` and
//!   receive a QR-code URL the user scans to pay.
//! - Inbound: PayJS calls our webhook with the payment result, signed via
//!   MD5 with the merchant's shared key.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

/// Builds the PayJS-style sign string. PayJS's official spec uses MD5 over
/// a sorted key=value query plus the merchant key; we wrap that here so the
/// signing rule lives in one place.
pub fn sign(params: &BTreeMap<String, String>, merchant_key: &str) -> String {
    let mut joined = params
        .iter()
        .filter(|(k, v)| k.as_str() != "sign" && !v.is_empty())
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    joined.push_str(&format!("&key={merchant_key}"));
    md5_upper_hex(joined.as_bytes())
}

pub fn verify(params: &BTreeMap<String, String>, merchant_key: &str) -> bool {
    let provided = match params.get("sign") {
        Some(s) => s.clone(),
        None => return false,
    };
    let expected = sign(params, merchant_key);
    provided.eq_ignore_ascii_case(&expected)
}

/// Plain MD5 implementation. We don't need a separate dep — sha2 doesn't
/// provide MD5, so we implement the four-round transform inline. Kept tiny
/// because it's only used for PayJS signature comparison, never for security.
fn md5_upper_hex(input: &[u8]) -> String {
    let digest = md5_compat(input);
    let mut out = String::with_capacity(32);
    for b in digest.iter() {
        out.push_str(&format!("{:02X}", b));
    }
    out
}

// Reasonably small reference MD5. Not constant-time, but webhook signatures
// don't need that.
fn md5_compat(input: &[u8]) -> [u8; 16] {
    // Use sha2-style approach is wrong for MD5; pull in a tiny loop.
    // Implementation adapted from the public-domain RSA reference impl.
    let mut padded = Vec::with_capacity(input.len() + 64);
    padded.extend_from_slice(input);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    let bit_len = (input.len() as u64).wrapping_mul(8);
    padded.extend_from_slice(&bit_len.to_le_bytes());

    let s: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    let k: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a,
        0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
        0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340,
        0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8,
        0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
        0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92,
        0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
        0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];

    let (mut a, mut b, mut c, mut d) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);

    for chunk in padded.chunks(64) {
        let mut m = [0u32; 16];
        for i in 0..16 {
            m[i] = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        let (mut aa, mut bb, mut cc, mut dd) = (a, b, c, d);
        for i in 0..64 {
            let (f, g) = if i < 16 {
                ((bb & cc) | ((!bb) & dd), i)
            } else if i < 32 {
                ((dd & bb) | ((!dd) & cc), (5 * i + 1) % 16)
            } else if i < 48 {
                (bb ^ cc ^ dd, (3 * i + 5) % 16)
            } else {
                (cc ^ (bb | (!dd)), (7 * i) % 16)
            };
            let f = f
                .wrapping_add(aa)
                .wrapping_add(k[i])
                .wrapping_add(m[g]);
            aa = dd;
            dd = cc;
            cc = bb;
            bb = bb.wrapping_add(f.rotate_left(s[i]));
        }
        a = a.wrapping_add(aa);
        b = b.wrapping_add(bb);
        c = c.wrapping_add(cc);
        d = d.wrapping_add(dd);
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&a.to_le_bytes());
    out[4..8].copy_from_slice(&b.to_le_bytes());
    out[8..12].copy_from_slice(&c.to_le_bytes());
    out[12..16].copy_from_slice(&d.to_le_bytes());
    out
}

/// SHA-256 hex digest helper, also exported for non-PayJS callers.
pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn md5_smoke() {
        // Cross-check with a known vector
        let got = md5_upper_hex(b"abc");
        assert_eq!(got, "900150983CD24FB0D6963F7D28E17F72");
    }
}
