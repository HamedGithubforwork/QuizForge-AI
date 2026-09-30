"""Bounded signed-out probe of the reviewed native client's classic login page."""
from html.parser import HTMLParser
import json
from pathlib import Path
import subprocess
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request

import boto3
from scripts.production.lightsail import native_auth_readiness as readiness

RESULT = Path('native-login-availability-results/summary.json')
PUBLIC_CONFIG = Path('native-desktop-public-config/runtime.json')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class LoginForm(HTMLParser):
    def __init__(self, origin):
        super().__init__()
        self.origin = origin
        self.active = False
        self.fields = set()
        self.found = False

    def handle_starttag(self, tag, attributes):
        values = dict(attributes)
        if tag == 'form':
            action = urlsplit(urljoin(self.origin + '/login', values.get('action', '')))
            self.active = (values.get('method', '').lower() == 'post' and
                           action.scheme == 'https' and 'https://' + action.netloc == self.origin and
                           action.path == '/login' and not action.username and not action.password)
            self.fields = set()
        elif tag == 'input' and self.active:
            name = values.get('name')
            if name == 'username' or (name == 'password' and values.get('type', '').lower() == 'password'):
                self.fields.add(name)

    def handle_endtag(self, tag):
        if tag == 'form':
            self.found |= self.active and self.fields == {'username', 'password'}
            self.active = False


def fetch(url):
    opener = build_opener(NoRedirect())
    try:
        response = opener.open(Request(url, headers={'User-Agent': 'QuizFromNotes-LoginReadiness/1'}), timeout=10)
    except HTTPError as error:
        response = error
    with response:
        body = response.read(262145)
        if len(body) > 262144:
            raise ValueError('Login response too large')
        return response.status, response.headers, body


def probe(url, origin, request=fetch):
    for _ in range(4):
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or 'https://' + parsed.netloc != origin or parsed.username or parsed.password
                or parsed.path not in ('/oauth2/authorize', '/login') or parsed.fragment
                or len(url) > 8192 or any(ord(char) <= 32 or ord(char) == 127 for char in url)):
            raise ValueError('Unexpected login destination')
        status, headers, body = request(url)
        if status in (301, 302, 303, 307, 308):
            location = headers.get('Location')
            if not location:
                raise ValueError('Missing redirect destination')
            url = urljoin(url, location)
            continue
        if status != 200 or 'text/html' not in headers.get('Content-Type', '').lower():
            raise ValueError('Login page unavailable')
        parser = LoginForm(origin)
        parser.feed(body.decode('utf-8', errors='strict'))
        if not parser.found:
            raise ValueError('Expected classic sign-in form missing')
        return True
    raise ValueError('Too many login redirects')


def public_runtime_config(description, pool_id, web_id, verify=readiness.verify_policy):
    # Verify the full service response before selecting only public routing IDs.
    verify(description, pool_id, web_id)
    client_id = description['UserPoolClient']['ClientId']
    if not readiness.CLIENT_RE.fullmatch(str(client_id)) or client_id == web_id:
        raise ValueError('Unexpected native client')
    return {'schema': 1, 'poolId': pool_id, 'clientId': client_id}


def main():
    report = {'schema': 1, 'result': 'login_page_unavailable', 'signed_out_login_page_verified': False,
              'credentials_submitted': False, 'account_login_verified': False, 'changes_performed': False}
    try:
        commit = readiness.source_commit()
        actual = subprocess.run(['git', '-C', str(readiness.CHECKOUT), 'rev-parse', 'HEAD'],
                                capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        if actual != commit:
            raise ValueError('Wrong policy checkout')
        cognito = boto3.client('cognito-idp', region_name=readiness.REGION)
        summary = readiness.inspect(boto3.client('sts', region_name=readiness.REGION), cognito)
        if not summary['native_client_present']:
            raise ValueError('Registration required')
        pool, web_id = readiness.discover(cognito)
        expected = readiness.expected_policy(pool)
        clients = [c for c in readiness.pages(cognito, 'list_user_pool_clients', 'UserPoolClients', UserPoolId=pool, MaxResults=60)
                   if c.get('ClientName') == expected['ClientName']]
        if len(clients) != 1 or not readiness.CLIENT_RE.fullmatch(str(clients[0].get('ClientId', ''))):
            raise ValueError('Unexpected native identity')
        # The actual desktop helper supplies PKCE, state, nonce, scopes and callback.
        script = "const path=require('node:path');const root=path.resolve(process.argv[1]);const {createAuthorizationAttempt}=require(root+'/desktop/src/native-auth-attempt.cjs');const {AUTH_ORIGIN}=require(root+'/desktop/src/policy.cjs');process.stdout.write(JSON.stringify({url:createAuthorizationAttempt({clientId:process.argv[2]}).authorizationUrl,origin:AUTH_ORIGIN}));"
        generated = subprocess.run(['node', '-e', script, str(readiness.CHECKOUT), clients[0]['ClientId']],
                                   capture_output=True, text=True, timeout=10, check=True)
        config = json.loads(generated.stdout)
        probe(config['url'], config['origin'])
        description = cognito.describe_user_pool_client(UserPoolId=pool, ClientId=clients[0]['ClientId'])
        public_config = public_runtime_config(description, pool, web_id)
        if public_config['clientId'] != clients[0]['ClientId']:
            raise ValueError('Native identity changed')
        PUBLIC_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        PUBLIC_CONFIG.write_text(json.dumps(public_config, indent=2) + '\n')
        report.update(result='signed_out_login_page_verified', signed_out_login_page_verified=True, configuration_commit=commit)
    except Exception:
        pass  # Service identifiers, HTML and exception messages are never logged.
    RESULT.parent.mkdir(parents=True, exist_ok=True)
    RESULT.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 0 if report['signed_out_login_page_verified'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
