#!/bin/bash

XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart pi-web-ui-local
