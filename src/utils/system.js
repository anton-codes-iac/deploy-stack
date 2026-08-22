import util from 'util';
import { exec } from 'child_process';

const execAsync = util.promisify(exec);

export async function checkDependency(command) {
    try {
        await execAsync(`${command} --version`);
        return true;
    } catch (error) {
        return false;
    }
}