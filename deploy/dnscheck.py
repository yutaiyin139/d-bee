"""通过 DNSPod DoH 查询域名记录（国内可访问）。"""
import json
import sys
import urllib.parse
import urllib.request

ENDPOINT = "https://doh.pub/dns-query"
RRTYPE = {1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 15: "MX", 16: "TXT", 28: "AAAA"}


def query(name, typ):
    url = f"{ENDPOINT}?name={urllib.parse.quote(name)}&type={typ}"
    req = urllib.request.Request(url, headers={"accept": "application/dns-json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def show(name, typ):
    try:
        d = query(name, typ)
    except Exception as e:  # noqa: BLE001
        print(f"  [{typ}] 查询失败: {e}")
        return None
    st = d.get("Status")
    label = {0: "NOERROR", 3: "NXDOMAIN"}.get(st, str(st))
    print(f"  [{typ}] Status={st} ({label})")
    answers = d.get("Answer") or []
    if answers:
        for a in answers:
            t = RRTYPE.get(a.get("type"), a.get("type"))
            print(f"      -> {a.get('name')} {t} {a.get('data')}")
    else:
        print("      -> (无 Answer：该类型记录不存在)")
    auth = d.get("Authority") or []
    for a in auth:
        t = RRTYPE.get(a.get("type"), a.get("type"))
        print(f"      [Authority] {a.get('name')} {t} {a.get('data')}")
    return answers


if __name__ == "__main__":
    name = sys.argv[1]
    types = sys.argv[2].split(",") if len(sys.argv) > 2 else ["A"]
    print(f"=== {name} ===")
    for t in types:
        show(name, t)
