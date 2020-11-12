import * as chalk from 'chalk'
import { jobs, job } from 'aws-iot-device-sdk'
import { progress, success, warn } from './log'
import { promises as fs } from 'fs'
import { download } from './download'
import { runJob } from './runJob'
import { flash } from './flash'
import {
	defaultTimeoutInMinutes,
	FirmwareCIJobDocument,
	RunningFirmwareCIJobDocument,
} from './job'
import { uploadToS3 } from './publishReport'
import { detectDK } from './detectDK'

const isUndefined = (a?: any): boolean => a === null || a === undefined

export const runner = async ({
	certificateJSON,
	atClientHexFile,
}: {
	certificateJSON: string
	atClientHexFile: string
}): Promise<void> => {
	// Check if a working nRF9160 is connected (by acquiring the IMEI)
	progress('Detecting DK...')
	const dkDevice = await detectDK({
		atClientHexFile,
	})
	success(
		`Detected DK with IMEI ${dkDevice.IMEI} connected to ${dkDevice.device}`,
	)

	const {
		clientId,
		brokerHostname,
		caCert,
		clientCert,
		privateKey,
	} = JSON.parse(await fs.readFile(certificateJSON, 'utf-8'))
	console.log(
		chalk.grey('  MQTT endpoint:       '),
		chalk.yellow(brokerHostname),
	)
	console.log(chalk.grey('  Device ID:           '), chalk.yellow(clientId))
	console.log(
		chalk.grey('  AT Client:           '),
		chalk.yellow(atClientHexFile),
	)
	console.log()

	await new Promise((resolve, reject) => {
		progress('Connecting')
		const connection = new jobs({
			privateKey: Buffer.from(privateKey.replace(/\\n/g, '\n')),
			clientCert: Buffer.from(clientCert.replace(/\\n/g, '\n')),
			caCert: Buffer.from(caCert.replace(/\\n/g, '\n')),
			clientId,
			host: brokerHostname,
		})

		connection.on('connect', () => {
			success(`Connected to ${brokerHostname} as ${clientId}.`)
			connection.subscribeToJobs(
				clientId,
				// There is a bug in the TypeScript definition
				// @ts-ignore
				async (err: Error, job: job): Promise<void> => {
					if (isUndefined(err)) {
						progress(
							clientId,
							'default job handler invoked, jobId:',
							job.id.toString(),
						)
						const doc: RunningFirmwareCIJobDocument = {
							id: job.id.toString(),
							timeoutInMinutes: defaultTimeoutInMinutes,
							...(job.document as FirmwareCIJobDocument),
						}
						if (
							new Date(doc.expires).getTime() <
							Date.now() + doc.timeoutInMinutes * 60 * 1000
						) {
							job.failed({
								progress: `aborted due to job expiry`,
							})
						}
						progress(clientId, 'job document', doc)
						job.inProgress({
							progress: `downloading ${doc.fw}`,
						})
						const hexFile = await download(job.id.toString(), doc.fw)
						job.inProgress({
							progress: 'running',
						})
						const report: Record<string, any> = {}
						let connection
						let conclusion
						try {
							const run = await runJob({
								doc,
								hexFile,
								dkDevice: dkDevice.device,
							})
							const { result, deviceLog, flashLog } = run
							connection = run.connection
							conclusion = () => {
								job.succeeded({
									progress: 'success',
								})
							}
							success(job.id, 'success')
							report.result = result
							report.flashLog = flashLog
							report.deviceLog = deviceLog
							report.connection = connection
							// Publish report
							progress(`Publishing report to`, doc.reportUrl)
							await uploadToS3(doc.reportPublishUrl, report)
						} catch (err) {
							warn(job.id, 'failed', err.message)
							report.error = err.message
							conclusion = () => {
								job.failed({
									progress: err.message,
								})
							}
						}
						// Remove hexfile
						await fs.unlink(hexFile)
						success(job.id, 'HEX file deleted')
						// Reset FW
						try {
							await flash('AT Host', atClientHexFile)
						} catch (err) {
							warn(`Failed to reset programmer: ${err.message}`)
						}
						if (connection !== undefined) connection.end()
						conclusion?.()
					} else {
						warn(clientId, err)
					}
				},
			)
		})

		connection.startJobNotifications(clientId, (err) => {
			if (isUndefined(err)) {
				success(clientId, `registered for jobs.`)
				resolve(connection)
			} else {
				warn(clientId, err)
				reject(err)
			}
		})

		connection.on('error', reject)
	})
}
