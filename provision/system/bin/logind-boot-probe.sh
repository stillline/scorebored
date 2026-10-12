#!/bin/bash
# Diagnostic: for the first 180 s after boot, ping systemd-logind over D-Bus
# once a second. On a failure, log the uptime and logind's kernel stack so a
# stalled logind can be attributed. Output goes to the journal (unit
# logind-boot-probe). Remove the unit once the labwc seat delay is understood.
end=$((SECONDS + 180)); fails=0
pid=$(systemctl show -p MainPID --value systemd-logind)
echo "probe start: logind pid $pid, uptime $(cut -d' ' -f1 /proc/uptime)"
while [ $SECONDS -lt $end ]; do
    if timeout 2 busctl --timeout=1 call org.freedesktop.login1 /org/freedesktop/login1 \
            org.freedesktop.DBus.Peer Ping >/dev/null 2>&1; then
        [ $fails -gt 0 ] && echo "logind answering again at uptime $(cut -d' ' -f1 /proc/uptime) after $fails failed pings"
        fails=0
    else
        fails=$((fails + 1))
        echo "PING FAILED #$fails at uptime $(cut -d' ' -f1 /proc/uptime) state=$(awk '{print $3}' /proc/$pid/stat 2>/dev/null) wchan=$(cat /proc/$pid/wchan 2>/dev/null)"
        echo "logind stack: $(tr '\n' ' ' < /proc/$pid/stack 2>/dev/null)"
        for t in /proc/$pid/task/*; do echo "  thread $(basename $t) wchan=$(cat $t/wchan 2>/dev/null)"; done
    fi
    sleep 1
done
echo "probe end at uptime $(cut -d' ' -f1 /proc/uptime)"
