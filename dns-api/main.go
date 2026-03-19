/* /dns-api/main.go
- HTTP server to be run on bruins.cs.ucla.edu for BIND9 nsupdate calls coming from authorized agents
- core features of server:
	1. validates HMAC signature of incoming requests
	2. checks nonce/timestamp as replay guard
	3. validates/sanitizes inputs
	4. shells out to nsupdate
	5. nsupdate talks to BIND9 with TSIG key (configured in /etc/bind .conf files)
*/

package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "os/exec"
    "regexp"
    "strings"
    "sync"
    "time"
)

var (
    hmacSecret string
    zone       string
    keyFile    string

    // replay protection: remember nonces for 5 minutes
    nonceMu   sync.Mutex
    noncesSeen = map[string]time.Time{}

    // only allow safe record name characters — letters, digits, dots, hyphens, underscores
    safeRecordName = regexp.MustCompile(`^[a-zA-Z0-9._-]+$`)

    // only allow printable ASCII in TXT values, no quotes or backslashes
    safeTxtValue = regexp.MustCompile(`^[a-zA-Z0-9 !#$%&'()*+,/:;<=>?@\[\]^_` + "`" + `{|}~-]+$`)
)

type insertRequest struct {
    RecordName string `json:"recordName"`
    Value      string `json:"value"`
    TTL        int    `json:"ttl"`
    Nonce      string `json:"nonce"`
    Timestamp  int64  `json:"timestamp"`
}

type deleteRequest struct {
    RecordName string `json:"recordName"`
    Nonce      string `json:"nonce"`
    Timestamp  int64  `json:"timestamp"`
}

func main() {
    hmacSecret = requireEnv("HMAC_SECRET")
    zone = requireEnv("DNS_ZONE")
    keyFile = requireEnv("TSIG_KEY_FILE")
    port := getEnvOr("PORT", "8765")
    bindAddr := getEnvOr("BIND_ADDR", "127.0.0.1") // default localhost only

    // background goroutine to clean up old nonces
    go func() {
        for {
            time.Sleep(time.Minute)
            nonceMu.Lock()
            cutoff := time.Now().Add(-5 * time.Minute)
            for n, t := range noncesSeen {
                if t.Before(cutoff) {
                    delete(noncesSeen, n)
                }
            }
            nonceMu.Unlock()
        }
    }()

    http.HandleFunc("/health", handleHealth)
    http.HandleFunc("/txt", handleTxt)

    addr := fmt.Sprintf("%s:%s", bindAddr, port)
    log.Printf("DNS API service listening on %s", addr)
    log.Fatal(http.ListenAndServe(addr, nil))
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    w.Write([]byte(`{"status":"ok"}`))
}

func handleTxt(w http.ResponseWriter, r *http.Request) {
    body, err := io.ReadAll(io.LimitReader(r.Body, 4096)) // cap body size
    if err != nil {
        http.Error(w, "bad request", http.StatusBadRequest)
        return
    }

    // validate HMAC
    if !validHmac(body, r.Header.Get("Authorization")) {
        log.Printf("HMAC validation failed from %s", r.RemoteAddr)
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }

    switch r.Method {
    case http.MethodPost:
        var req insertRequest
        if err := json.Unmarshal(body, &req); err != nil {
            http.Error(w, "invalid json", http.StatusBadRequest)
            return
        }
        if err := validateReplay(req.Nonce, req.Timestamp); err != nil {
            http.Error(w, err.Error(), http.StatusUnauthorized)
            return
        }
        if err := validateRecordName(req.RecordName); err != nil {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }
        if err := validateTxtValue(req.Value); err != nil {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }
        if req.TTL <= 0 {
            req.TTL = 60
        }
        if err := nsupdate(fmt.Sprintf(
            "server 127.0.0.1\nzone %s.\nupdate add %s. %d IN TXT \"%s\"\nsend\n",
            zone, req.RecordName, req.TTL, req.Value,
        )); err != nil {
            log.Printf("nsupdate insert error: %v", err)
            http.Error(w, "DNS update failed", http.StatusInternalServerError)
            return
        }
        log.Printf("inserted TXT %s", req.RecordName)
        w.WriteHeader(http.StatusOK)

    case http.MethodDelete:
        var req deleteRequest
        if err := json.Unmarshal(body, &req); err != nil {
            http.Error(w, "invalid json", http.StatusBadRequest)
            return
        }
        if err := validateReplay(req.Nonce, req.Timestamp); err != nil {
            http.Error(w, err.Error(), http.StatusUnauthorized)
            return
        }
        if err := validateRecordName(req.RecordName); err != nil {
            http.Error(w, err.Error(), http.StatusBadRequest)
            return
        }
        if err := nsupdate(fmt.Sprintf(
            "server 127.0.0.1\nzone %s.\nupdate delete %s. TXT\nsend\n",
            zone, req.RecordName,
        )); err != nil {
            log.Printf("nsupdate delete error: %v", err)
            http.Error(w, "DNS update failed", http.StatusInternalServerError)
            return
        }
        log.Printf("deleted TXT %s", req.RecordName)
        w.WriteHeader(http.StatusOK)

    default:
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
    }
}

func validateRecordName(name string) error {
    if name == "" {
        return fmt.Errorf("recordName is required")
    }
    if !strings.HasSuffix(name, "."+zone) && name != zone {
        return fmt.Errorf("recordName must be within zone %s", zone)
    }
    if !safeRecordName.MatchString(name) {
        return fmt.Errorf("recordName contains invalid characters")
    }
    return nil
}

func validateTxtValue(value string) error {
    if value == "" {
        return fmt.Errorf("value is required")
    }
    if !safeTxtValue.MatchString(value) {
        return fmt.Errorf("value contains invalid characters")
    }
    return nil
}

func validateReplay(nonce string, timestamp int64) error {
    if nonce == "" {
        return fmt.Errorf("nonce is required")
    }
    // reject requests older than 2 minutes
    age := time.Since(time.Unix(timestamp, 0))
    if age > 2*time.Minute || age < -30*time.Second {
        return fmt.Errorf("request timestamp out of window")
    }
    nonceMu.Lock()
    defer nonceMu.Unlock()
    if _, seen := noncesSeen[nonce]; seen {
        return fmt.Errorf("replayed nonce")
    }
    noncesSeen[nonce] = time.Now()
    return nil
}

func nsupdate(input string) error {
    cmd := exec.Command("nsupdate", "-k", keyFile)
    cmd.Stdin = strings.NewReader(input)
    out, err := cmd.CombinedOutput()
    if err != nil {
        return fmt.Errorf("%v: %s", err, out)
    }
    return nil
}

func validHmac(body []byte, sig string) bool {
    mac := hmac.New(sha256.New, []byte(hmacSecret))
    mac.Write(body)
    expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
    return hmac.Equal([]byte(sig), []byte(expected))
}

func requireEnv(key string) string {
    v := os.Getenv(key)
    if v == "" {
        log.Fatalf("missing required env var: %s", key)
    }
    return v
}

func getEnvOr(key, def string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return def
}