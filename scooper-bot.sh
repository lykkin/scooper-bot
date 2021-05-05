#!/bin/bash

export TELEGRAM_TOKEN=nope
export TELEGRAM_USER_ID=nope
export IFF_SUBMISSION_SALT=nope

while getopts s:t:u:S: flag
do
    case "${flag}" in
        s) working_dir=${OPTARG};;
        t) TELEGRAM_TOKEN=${OPTARG};;
        u) TELEGRAM_USER_ID=${OPTARG};;
        S) IFF_SUBMISSION_SALT=${OPTARG};;
    esac
done

echo "DIR: $working_dir"
echo "TOKEN: $TELEGRAM_TOKEN"
echo "USER ID: $TELEGRAM_USER_ID"
echo "SALT: $IFF_SUBMISSION_SALT"

cd $working_dir
nodejs ./index.js
